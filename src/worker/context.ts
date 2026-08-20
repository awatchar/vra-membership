import type { Logger } from './lib/logger';
import type { WorkerConfig, WorkerEnv } from './env';
import type { Providers } from './providers';

/** Hono generics for every route in the application. */
export interface AppContext {
  Bindings: WorkerEnv;
  Variables: {
    requestId: string;
    config: WorkerConfig;
    logger: Logger;
    providers: Providers;
  };
}
