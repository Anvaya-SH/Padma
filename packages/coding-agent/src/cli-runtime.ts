import { setupCli } from "./cli/setup.ts";
import { main } from "./main.ts";

setupCli();
void main(process.argv.slice(2));
