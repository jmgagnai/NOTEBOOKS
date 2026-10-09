/**
 * A stubbed client whose every answer — resolved or rejected — arrives a
 * moment after it is asked for, as a server's does. A stub that answers in
 * the same tick lets a page render its loading state and its loaded state
 * in one go, and hides every bug that lives between the two: NBK-97 shipped
 * one (a Chat Thread opened at an Exchange then scrolled itself to the
 * bottom) that only a delayed answer showed. The shared render helpers wrap
 * their clients with this, so every page spec runs with realistic ordering.
 *
 * The stub's own functions are still what is called, so `vi.fn()`
 * assertions and `mockResolvedValueOnce` work as before; a test that holds
 * an answer back by hand still decides when it lands, plus the delay.
 */
export const ANSWER_DELAY_MS = 10;

export function answeringLater<T extends object>(service: T): T {
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const result = value.apply(target, args);
        return isThenable(result) ? later(result) : result;
      };
    },
  });
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | null)?.then === 'function';
}

function later<V>(answer: PromiseLike<V>): Promise<V> {
  const wait = () => new Promise((resolve) => setTimeout(resolve, ANSWER_DELAY_MS));
  return Promise.resolve(answer).then(
    async (value) => {
      await wait();
      return value;
    },
    async (error: unknown) => {
      await wait();
      throw error;
    },
  );
}
