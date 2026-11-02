// How tsc, here in Node, sees the two things the endpoint template gets from
// the Edge runtime. This file is never copied to a user's app: under Deno the
// real types apply (and `deno check`, run by the tests, checks them against
// the real supabase-js).

declare const Deno: {
  env: { get(key: string): string | undefined };
  serve: (handler: (request: Request) => Response | Promise<Response>) => unknown;
};

declare module "npm:@supabase/supabase-js@2" {
  export interface SupabaseClient {
    from(table: string): unknown;
    auth: { admin: unknown };
  }
  export function createClient(url: string, key: string, options?: { auth?: { persistSession?: boolean } }): SupabaseClient;
}
