/// <reference types="vite/client" />

// biome-ignore lint/style/useNamingConvention: HTTP and URL are fullcaps acronyms
type HTTP_URL = `http${"" | "s"}://${string}`;

// Declaration merging for vite's `import.meta.env`.

interface ImportMetaEnv {
  // TODO: There doesn't appear to be a way to override Vite's definition of MODE;
  // it still shows up as "string"...
  readonly MODE: "development" | "beta" | "production" | "test" | "app";
  readonly VITE_PORT?: `${number}`;
  readonly VITE_BYPASS_LOGIN?: "0" | "1";
  readonly VITE_BYPASS_TUTORIAL?: "0" | "1";
  readonly VITE_API_BASE_URL?: HTTP_URL;
  readonly VITE_SERVER_URL?: HTTP_URL;
  /** The co-op relay, for example `wss://relay.example.com/coop`; default `/coop` of the page's own origin (D22) */
  readonly VITE_COOP_RELAY_URL?: string;
  /** The repository of this fork, linked from the title screen (D25); a production build needs it */
  readonly VITE_SOURCE_URL?: string;
  /** `1` in the image the browser tests run against: it has the debug API `window.__coop`. Never in a deployed image. */
  readonly VITE_COOP_E2E?: "0" | "1";
  readonly VITE_DISCORD_CLIENT_ID?: string;
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  readonly VITE_I18N_DEBUG?: "0" | "1";
  readonly VITE_WIKI_URL: string;
  readonly VITE_DISCORD_URL: string;
  readonly VITE_GITHUB_URL: string;
  readonly VITE_REDDIT_URL: string;
  readonly VITE_DONATE_URL: string;
}

// tell vite to disallow missing env vars
interface ViteTypeOptions {
  strictImportMetaEnv: unknown;
}

/** Co-op build identity, injected by `vite.config.ts` (see `src/coop/build-info.ts`). */
declare const __COOP_GIT_SHA__: string;
declare const __COOP_DIRTY_HASH__: string;
