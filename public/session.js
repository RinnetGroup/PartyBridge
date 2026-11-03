// Share the first bootstrap so page modules cannot create competing cookies.
export function createSessionBootstrap(fetchImpl) {
  let pending;
  return function bootstrap() {
    if (!pending)
      pending = fetchImpl('/api/bootstrap', {
        signal: AbortSignal.timeout(8000),
      })
        .then(async (response) => {
          if (!response.ok) throw new Error('Could not start a local session.');
          return response.json();
        })
        .catch((error) => {
          pending = null;
          throw error;
        });
    return pending;
  };
}
export const bootstrapSession = createSessionBootstrap((...args) => fetch(...args));
