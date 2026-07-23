export class OrderedTaskQueue {
  #tail = Promise.resolve();
  #pending = 0;
  #capacityWaiters = [];
  #stateWaiters = [];
  #isBackpressured = false;

  constructor({
    maxPending = 32,
    maxWaiting = maxPending,
    taskTimeoutMs = 30_000,
    admissionTimeoutMs = 5_000,
    onBackpressureChange = () => {},
  } = {}) {
    if (!Number.isSafeInteger(maxPending) || maxPending < 1) throw new Error("INVALID_QUEUE_CAPACITY");
    if (!Number.isSafeInteger(maxWaiting) || maxWaiting < 1) throw new Error("INVALID_QUEUE_WAIT_CAPACITY");
    this.maxPending = maxPending;
    this.maxWaiting = maxWaiting;
    this.taskTimeoutMs = taskTimeoutMs;
    this.admissionTimeoutMs = admissionTimeoutMs;
    this.onBackpressureChange = onBackpressureChange;
  }

  async submit(task) {
    if (typeof task !== "function") throw new Error("INVALID_QUEUE_TASK");
    await this.#acquireCapacity();
    const completion = this.#tail.then(() => this.#runBounded(task));
    this.#tail = completion.catch(() => undefined).finally(() => {
      this.#releaseCapacity();
    });
    return { completion };
  }

  async enqueue(task) {
    const { completion } = await this.submit(task);
    return completion;
  }

  async drain() {
    while (this.#pending > 0 || this.#capacityWaiters.length > 0) {
      await new Promise((resolve) => this.#stateWaiters.push(resolve));
    }
  }

  get pending() {
    return this.#pending;
  }

  get isBackpressured() {
    return this.#isBackpressured;
  }

  #acquireCapacity() {
    if (this.#pending < this.maxPending) {
      this.#pending += 1;
      return Promise.resolve();
    }
    if (this.#capacityWaiters.length >= this.maxWaiting) throw new Error("QUEUE_BACKPRESSURE_EXCEEDED");
    this.#setBackpressured(true);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      if (Number.isFinite(this.admissionTimeoutMs) && this.admissionTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const index = this.#capacityWaiters.indexOf(waiter);
          if (index < 0) return;
          this.#capacityWaiters.splice(index, 1);
          if (this.#capacityWaiters.length === 0) this.#setBackpressured(false);
          this.#notifyStateChange();
          reject(new Error("QUEUE_ADMISSION_TIMEOUT"));
        }, this.admissionTimeoutMs);
      }
      this.#capacityWaiters.push(waiter);
    });
  }

  #releaseCapacity() {
    this.#pending -= 1;
    const waiter = this.#capacityWaiters.shift();
    if (waiter) {
      if (waiter.timer) clearTimeout(waiter.timer);
      this.#pending += 1;
      waiter.resolve();
    }
    if (this.#capacityWaiters.length === 0) this.#setBackpressured(false);
    this.#notifyStateChange();
  }

  #setBackpressured(value) {
    if (this.#isBackpressured === value) return;
    this.#isBackpressured = value;
    this.onBackpressureChange(value);
  }

  async #runBounded(task) {
    const abortController = new AbortController();
    const work = Promise.resolve().then(() => task(abortController.signal));
    if (!Number.isFinite(this.taskTimeoutMs) || this.taskTimeoutMs <= 0) return work;
    work.catch(() => undefined);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        abortController.abort();
        reject(new Error("QUEUE_TASK_TIMEOUT"));
      }, this.taskTimeoutMs);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  #notifyStateChange() {
    const waiters = this.#stateWaiters;
    this.#stateWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
