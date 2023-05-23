import { blowUp, createNumber, describe, expect, it } from "./suite.ts";
import {
  createChannel,
  expect as $expect,
  Operation,
  run,
  sleep,
  spawn,
  Subscription,
  suspend,
} from "../mod.ts";

interface Action {
  type: string;
  payload?: unknown;
}

describe("run()", () => {
  it("can compose multiple promises via generator", async () => {
    let result = await run(function* () {
      let one = yield* $expect(Promise.resolve(12));
      let two = yield* $expect(Promise.resolve(55));
      return one + two;
    });
    expect(result).toEqual(67);
  });

  it("can compose operations", async () => {
    let result = await run(function* () {
      let one = yield* createNumber(12);
      let two = yield* createNumber(55);
      return one + two;
    });
    expect(result).toEqual(67);
  });

  it("rejects generator if subtask promise fails", async () => {
    let error = new Error("boom");
    let task = run(function* () {
      let one = yield* createNumber(12);
      let two = yield* blowUp<number>();
      return one + two;
    });
    await expect(task).rejects.toEqual(error);
  });

  it("rejects generator if generator creation fails", async () => {
    let task = run(function () {
      throw new Error("boom");
    });
    await expect(task).rejects.toHaveProperty("message", "boom");
  });

  it("can recover from errors in promise", async () => {
    let error = new Error("boom");
    let task = run(function* () {
      let one = yield* $expect(Promise.resolve(12));
      let two;
      try {
        yield* $expect(Promise.reject(error));
        two = 9;
      } catch (_) {
        // swallow error and yield in catch block
        two = yield* $expect(Promise.resolve(8));
      }
      let three = yield* $expect(Promise.resolve(55));
      return one + two + three;
    });
    await expect(task).resolves.toEqual(75);
  });

  it("can recover from errors in operation", async () => {
    let task = run(function* () {
      let one = yield* $expect(Promise.resolve(12));
      let two;
      try {
        yield* blowUp();
        two = 9;
      } catch (_e) {
        // swallow error and yield in catch block
        two = yield* $expect(Promise.resolve(8));
      }
      let three = yield* $expect(Promise.resolve(55));
      return one + two + three;
    });
    await expect(task).resolves.toEqual(75);
  });

  it("can halt generator", async () => {
    let halted = false;
    let task = run(function* () {
      try {
        yield* suspend();
      } finally {
        halted = true;
      }
    });

    await task.halt();

    await expect(task).rejects.toHaveProperty("message", "halted");
    expect(halted).toEqual(true);
  });

  it("halts task when halted generator", async () => {
    let parent = "running";
    let child = "running";
    let task = run(function* () {
      try {
        yield* (function* () {
          try {
            yield* suspend();
          } finally {
            child = "halted";
          }
        })();
      } finally {
        parent = "halted";
      }
    });

    await task.halt();

    await expect(task).rejects.toHaveProperty("message", "halted");
    expect(child).toEqual("halted");
    expect(parent).toEqual("halted");
  });

  it("can perform async operations in a finally block", async () => {
    let completed = false;

    let task = run(function* () {
      try {
        yield* suspend();
      } finally {
        yield* sleep(10);
        completed = true;
      }
    });

    await task.halt();

    expect(completed).toEqual(true);
  });

  it("cannot explicitly suspend in a finally block", async () => {
    let done = false;
    let task = run(function* () {
      try {
        yield* suspend();
      } finally {
        yield* suspend();
        done = true;
      }
    });

    await task.halt();
    expect(done).toEqual(true);
  });

  it("can suspend in yielded finally block", async () => {
    let things: string[] = [];

    let task = run(function* () {
      try {
        yield* (function* () {
          try {
            yield* suspend();
          } finally {
            yield* sleep(5);
            things.push("first");
          }
        })();
      } finally {
        things.push("second");
      }
    });

    await task.halt();

    await expect(task).rejects.toHaveProperty("message", "halted");

    expect(things).toEqual(["first", "second"]);
  });

  it("can be halted while in the generator", async () => {
    let task = run(function* Main() {
      yield* spawn(function* Boomer() {
        yield* sleep(2);
        throw new Error("boom");
      });

      yield* suspend();
    });

    await expect(task).rejects.toHaveProperty("message", "boom");
  });

  it("can halt itself", async () => {
    let task = run(function* () {
      yield* sleep(3);
      task.halt();
    });

    await expect(task).rejects.toHaveProperty("message", "halted");
  });

  it("can halt itself between yield points", async () => {
    let task = run(function* () {
      yield* sleep(1);

      yield* spawn(function* () {
        task.halt();
      });

      yield* suspend();
    });

    await expect(task).rejects.toHaveProperty("message", "halted");
  });

  it("can delay halt if child fails", async () => {
    let didRun = false;
    let task = run(function* () {
      yield* spawn(function* willBoom() {
        yield* sleep(5);
        throw new Error("boom");
      });
      try {
        yield* suspend();
      } finally {
        yield* sleep(20);
        didRun = true;
      }
    });

    await run(() => sleep(10));

    await expect(task).rejects.toHaveProperty("message", "boom");
    expect(didRun).toEqual(true);
  });

  it("can throw error when child blows up", async () => {
    let task = run(function* Main() {
      yield* spawn(function* Boomer() {
        yield* sleep(5);
        throw new Error("boom");
      });
      try {
        yield* suspend();
      } finally {
        // deno-lint-ignore no-unsafe-finally
        throw new Error("bang");
      }
    });

    await expect(task).rejects.toHaveProperty("message", "bang");
  });

  it("propagates errors", async () => {
    try {
      await run(function* () {
        throw new Error("boom");
      });
      throw new Error("expected error to propagate");
    } catch (error) {
      expect(error.message).toEqual("boom");
    }
  });

  it("propagates errors from promises", async () => {
    try {
      await run(function* () {
        yield* $expect(Promise.reject(new Error("boom")));
      });
      throw new Error("expected error to propagate");
    } catch (error) {
      expect(error.message).toEqual("boom");
    }
  });

  it("should listen for actions inside an operation", async () => {
    const channel = createChannel<{ type: string }>();
    let counter = 0;

    function* op(action: { type: string }) {
      if (counter < 2) {
        const { input } = channel;
        yield* input.send({ type: action.type });
      }
      counter += 1;
    }

    function* take(
      subscription: Subscription<{ type: string }, void>,
      pattern: string,
    ) {
      let next = yield* subscription.next();
      while (!next.done) {
        if (next.value.type === pattern) {
          return next.value;
        }

        next = yield* subscription.next();
      }
    }

    await run(function* () {
      const { output } = channel;
      const subscription = yield* output;

      const task = yield* spawn(function* () {
        while (true) {
          if (counter === 3) {
            break;
          }

          const action = yield* take(subscription, "test");
          if (!action) continue;
          const tsk = yield* spawn(function* () {
            yield* op(action);
          });
          yield* tsk;
        }
      });

      const { input } = channel;
      yield* input.send({ type: "test" });
      yield* task;
    });

    expect(counter).toBe(3);
  });

  it("should take every", async () => {
    const channel = createChannel<Action>();
    let actual: Action[] = [];

    function* op(action: Action) {
      actual.push(action);
    }

    function* take(
      subscription: Subscription<Action, void>,
      pattern: string,
    ) {
      let next = yield* subscription.next();
      while (!next.done) {
        if (next.value.type === pattern) {
          return next.value;
        }

        next = yield* subscription.next();
      }
    }

    function* takeEvery(
      pattern: string,
      op: (action: Action) => Operation<void>,
    ) {
      return yield* spawn(function* () {
        const sub = yield* channel.output;
        while (true) {
          const action = yield* take(sub, pattern);
          if (!action) continue;
          yield* spawn(() => op(action));
        }
      });
    }

    await run(function* () {
      const { output } = channel;
      const subscription = yield* output;

      const task = yield* spawn(function* () {
        const tsk = yield* takeEvery("test", op);
        yield* take(subscription, "CANCEL");
        yield* tsk.halt();
      });

      const { input } = channel;
      yield* input.send({ type: "test", payload: 1 });
      yield* input.send({ type: "test", payload: 2 });
      yield* input.send({ type: "test", payload: 3 });
      yield* input.send({ type: "test", payload: 4 });
      yield* input.send({ type: "CANCEL" });
      yield* input.send({ type: "test", payload: 1 });
      yield* input.send({ type: "test", payload: 2 });
      yield* task;
    });

    expect(actual).toEqual([
      { type: "test", payload: 1 },
      { type: "test", payload: 2 },
      { type: "test", payload: 3 },
      { type: "test", payload: 4 },
    ]);
  });
});