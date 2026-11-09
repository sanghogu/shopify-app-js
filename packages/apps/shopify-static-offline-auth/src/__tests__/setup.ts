// Install before importing Shopify: its runtime captures fetch at module load.
globalThis.fetch = jest.fn(async () => {
  throw new Error('Unexpected network request in a unit test');
});

beforeEach(() => jest.clearAllMocks());
