import { AsyncLocalStorage } from "node:async_hooks";
import { requireWorkerBindings, type WorkerBindings } from "./types";

interface AccountRequestContext {
  rawBindings: unknown;
  bindings?: WorkerBindings;
  waitUntil: ((work: Promise<unknown>) => void) | undefined;
}

const requests = new AsyncLocalStorage<AccountRequestContext>();

/** Keeps account bindings and background work owned by their HTTP invocation on either runtime. */
export function withAccountRequest<T>(
  bindings: unknown,
  waitUntil: AccountRequestContext["waitUntil"],
  operation: () => T,
): T {
  return requests.run({ rawBindings: bindings, waitUntil }, operation);
}

export function accountRequestBindings(): WorkerBindings {
  const context = requests.getStore();
  if (!context) throw new Error("Account request context is unavailable.");
  context.bindings ??= requireWorkerBindings(context.rawBindings);
  return context.bindings;
}

export function accountRequestWaitUntil(work: Promise<unknown>): void {
  const context = requests.getStore();
  if (!context?.waitUntil) throw new Error("Account background-work context is unavailable.");
  context.waitUntil(work);
}
