// An offer is one transaction, including its REST answer. Never let a later
// participant update replace the remote description halfway through that work.
export class OfferQueue {
  constructor(apply, onPending = () => {}) {
    this.apply = apply;
    this.onPending = onPending;
    this.tail = Promise.resolve();
    this.pending = 0;
    this.closed = false;
    this.queuedRefresh = null;
  }

  enqueue(offer) {
    if (this.closed) return Promise.reject(new Error('Voice negotiation cancelled'));
    // Null notifications all mean "fetch the latest offer". Share a queued
    // fetch, but allow one follow-up after the active fetch has already begun.
    if (offer == null && this.queuedRefresh) return this.queuedRefresh;
    this.onPending(++this.pending);
    const work = this.tail.then(() => {
      if (this.queuedRefresh === result) this.queuedRefresh = null;
      if (this.closed) throw new Error('Voice negotiation cancelled');
      return this.apply(offer);
    });
    const result = work
      .catch((error) => {
        this.close();
        throw error;
      })
      .finally(() => {
        if (this.queuedRefresh === result) this.queuedRefresh = null;
        this.onPending(--this.pending);
      });
    if (offer == null) this.queuedRefresh = result;
    this.tail = result.catch(() => {});
    return result;
  }

  close() {
    this.closed = true;
  }
  idle() {
    return this.tail;
  }
}
