// contacts — one function: add or update a contact.
//
//   import { upsertContact, tools } from "<workspace>/app/contacts/src/index.js";
//
// `tools` is the grandma-kat tool wrapper (see src/tools.js); the database is
// <workspace>/contacts.db (see config.js).

export { upsertContact } from "./upsert.js";
export { logMessage, listMessages } from "./messages.js";
export { getContact, searchContacts } from "./search.js";
export { tools } from "./tools.js";
export { closeDb, queryContactIds, findIdsByName } from "./db.js";
export { splitPhones, transformImportValue } from "./import-values.js";
export { config } from "../config.js";
export { default as tree } from "../tree.mjs";
