# Threads Project Specification

## Overview

Threads is a framework for making low-intelligence LLM models more capable at specific tasks through granular, composable execution units. Unlike traditional agent/subagent patterns, Threads breaks work into highly granular, predefined sequences with memory persistence.

## Core Concepts

### Thread

A Thread is the fundamental execution unit. Each Thread has:

- **Static components**: Predefined sequence of Steps (questions/prompts)
- **Dynamic components**: Memory accumulated during execution
- **Parent reference**: Every Thread has a parent Thread, except the root Thread
- **Model**: Can specify an LLM model, defaulting to parent's model. The root Thread MUST specify a model.

### Thread Definition

```json
{
  "threads": [
    {
      "id": "abcd",
      "model": "optional-model-id",
      "steps": [
        {
          "id": "efgh",
          "prompt": "...",
          "available_tools": [],
          "model": "optional-step-model",
          "memory_inputs": ["step-id-1", "step-id-2"],
          "conditions": [
            {
              "check": "response_is_done",
              "result": "next"
            },
            {
              "check": "response_is_tool_call",
              "result": "next"
            },
            {
              "check": "retries_less_than_3",
              "result": "retry"
            },
            {
              "check": "custom_check",
              "result": "goto",
              "target_step_id": "ijkl"
            }
          ]
        }
      ]
    }
  ]
}
```

### Step

A Step is a single unit within a Thread. Steps can:

- Execute a prompt against an LLM model
- Reference another Thread (step becomes a pointer to a Thread)
- Define which Memory pieces to include in a Call
- Define conditions for validation and flow control

### Call

A Call is a single execution of a Step. A Step may produce multiple Calls through retries. Each Call:

- Sends a prompt to the model
- Receives a response (potentially with tool calls)
- Executes any tool calls
- Stores results in Memory
- Logs the execution

### Memory

Memory is the runtime context accumulated during execution. Memory is pulled into a Call based on the Step's `memory_inputs`, which reference the results of prior steps. Memory is ephemeral during a Thread's execution but persisted by writing to the Logging database.

### Logging

Persistent storage using SQLite. Every Call is logged. Schema:

| Column               | Type    | Description                                        |
|----------------------|---------|----------------------------------------------------|
| thread_id            | TEXT    | Thread identifier                                  |
| thread_instance_id   | TEXT    | Instance ID for parallel executions                |
| step_id             | TEXT    | Step identifier                                    |
| call_id             | INTEGER | Auto-incremented sequence for every call, in execution order (serves as unique call identifier) |
| tool_call_id         | TEXT    | Optional tool call identifier                      |
| content              | TEXT    | Content/result                                     |
| is_complete          | BOOLEAN | `false` until step completes successfully          |

### Conditions

Conditions are predefined checks that determine flow control. Each condition has:

- **check**: The validation to perform (e.g., `response_is_done`, `response_is_tool_call`, `retries_less_than_N`)
- **result**: What happens if check passes:
  - `next` - Proceed to next step
  - `retry` - Re-execute current step
  - `goto` - Jump to specified step_id
- **target_step_id**: Required when result is `goto`

### Memory Inputs

Steps specify `memory_inputs` as a list of step_ids. The results of those steps are pulled from the Memory and included in the Call's context.

### Step Lifecycle

A Step has two execution paths: **model invocation** (runs a prompt against an LLM) or **sub-Thread delegation** (runs another Thread). Both share the same lifecycle phases below.

#### 1. Step Resolution (at Thread load time)

- **Model resolution**: `step.model` → `thread.model` → parent thread → root thread. Every Step must resolve to a model before execution; if none is found, the Thread fails to load.
- **Sub-Thread resolution**: If the Step references another Thread (via a `thread_id` pointer), resolve and validate the target Thread. The Step's `prompt` is optional in this case.
- **Memory input validation**: Each `memory_input` must reference a valid step_id within the same Thread.
- **Condition validation**: `goto` targets must exist as step_ids within the same Thread.

#### 2. Context Assembly (per Call, before model invocation)

- For each `step_id` in `memory_inputs`, pull all logged rows for that step from the current Thread instance — this includes model responses and tool call results.
- If this is a retry, also include tool results from previous Calls of this same Step (stored under the current step_id with `is_complete: false`).
- Compose the Call's final prompt: the Step's static `prompt` + assembled memory context.
- Resolve `available_tools` for the Call.

#### 3. Model Invocation (the Call)

- Send the composed prompt + memory context + `available_tools` to the resolved model.
- Receive a response containing text and/or tool calls.
- Log the Call: one row with `call_id` auto-incremented, `tool_call_id = null`, `content = response`, `is_complete = false`.

#### 4. Tool Execution (if response contains tool calls)

- For each tool call in the response:
  - Execute the tool.
  - Log the result: one row per tool call with `call_id` auto-incremented, `tool_call_id = <id>`, `content = tool_result`, `is_complete = false`.
  - Store the result in Memory under the current step_id.
- Tool results become available to subsequent Calls via `memory_inputs` referencing this step.
- After all tool calls are executed, proceed to Condition Evaluation.

#### 5. Condition Evaluation

- Evaluate conditions in **declared order**. The **first matching condition wins**; evaluation stops at the first match.
- Standard checks:
  - `response_is_done` — the response is a final answer (no pending tool calls).
  - `response_is_tool_call` — the response includes tool calls.
  - `retries_less_than_N` — the retry counter is below N.
  - `custom_check` — implementation-defined.
- **If no condition matches**: the Step halts in an error state. Thread execution stops.

#### 6. Flow Control (outcome of the matched condition)

- **`next`**: Mark the Step complete (log a row with `is_complete = true`). Advance to the next Step in the Thread.
- **`retry`**: Increment the retry counter. Re-execute the Step — start a new Call (return to Context Assembly) with Memory updated to include tool results from the previous Call.
- **`goto`**: Mark the Step complete (log a row with `is_complete = true`). Jump to `target_step_id`.

#### 7. Sub-Thread Delegation (if Step references a Thread)

Instead of model invocation, the Step delegates to the referenced Thread:

- Context Assembly happens as normal (`memory_inputs` resolved).
- The sub-Thread executes its own Step sequence with its own Calls.
- All Calls within the sub-Thread are logged with the sub-Thread's `thread_id` but share the same `thread_instance_id` for traceability.
- When the sub-Thread completes, its final result (the last completed Step's content) is stored in Memory for this Step.
- The Step's conditions (if any) are evaluated against the sub-Thread's final result. If no conditions are defined, the Step defaults to `next`.
- Mark the Step complete (`is_complete = true`).

## Example Flow

```
Root Thread (model: gpt-4)
  ├─ Step 1: Initialize context
  │   └─ memory_inputs: []
  │   └─ conditions: [response_is_done → next]
  │
  ├─ Step 2: Analyze input
  │   └─ memory_inputs: ["step-1"]
  │   └─ conditions: [response_is_tool_call → next, retries < 3 → retry]
  │
  ├─ Step 3: Execute Sub-Thread (pointer to Thread "sub-1")
  │   └─ memory_inputs: ["step-1", "step-2"]
  │
  └─ Step 4: Synthesize results
      └─ memory_inputs: ["step-1", "step-2", "step-3"]
      └─ conditions: [response_is_done → next]
```

## Implementation Notes

- IDs are 4-letter short identifiers
- Tool execution results are stored in Memory with `is_complete: false`
- Only successful step completion sets `is_complete: true`
- Memory is ephemeral at runtime; the Logging database is the persistent record of all Calls
- `call_id` is auto-incremented for every Call logged, in execution order, serving as the unique call identifier
- Model inheritance: step → thread → parent thread → root thread (explicit model required at root)
