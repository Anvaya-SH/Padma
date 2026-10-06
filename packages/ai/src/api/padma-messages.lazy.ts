import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const padmaMessagesApi = (): ProviderStreams => lazyApi(() => import("./padma-messages.ts"));
