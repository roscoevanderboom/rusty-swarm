/** Coalesce overlapping async calls, then allow future calls after settlement. */
export function singleFlight<Args extends unknown[], Result>(
  operation: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  let inFlight: Promise<Result> | null = null;

  return (...args: Args) => {
    if (inFlight) return inFlight;

    const request = (async () => operation(...args))();
    inFlight = request;
    void request.then(
      () => {
        if (inFlight === request) inFlight = null;
      },
      () => {
        if (inFlight === request) inFlight = null;
      },
    );
    return request;
  };
}
