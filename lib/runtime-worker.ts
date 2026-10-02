// Retained only for the legacy Worker build and isolated Worker regression tests.
import { env } from "cloudflare:workers";
import { setBindingsProvider, type PortalBindings } from "./runtime";

setBindingsProvider(() => env as unknown as PortalBindings);
