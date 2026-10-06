import * as durable from "@anvaya.sh/padma-durable";
import * as environment from "@anvaya.sh/padma-durable/env";
import * as jsonl from "@anvaya.sh/padma-durable/storage/jsonl";
import * as sqlite from "@anvaya.sh/padma-durable/storage/sqlite";

// Keep runtime-neutral public entry points live so the browser smoke build
// catches accidental imports of Node-only adapters or built-ins.
console.log(Object.keys(durable), Object.keys(environment), Object.keys(jsonl), Object.keys(sqlite));
