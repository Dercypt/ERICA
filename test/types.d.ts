declare module 'node:test' {
  interface TestFunction {
    (name: string, fn: (t?: any) => void | Promise<void>): void;
    beforeEach(fn: () => void | Promise<void>): void;
    afterEach?(fn: () => void | Promise<void>): void;
  }
  const test: TestFunction;
  export default test;
}

declare module 'node:assert' {
  interface Assert {
    strictEqual(actual: any, expected: any, message?: string): void;
    notStrictEqual(actual: any, expected: any, message?: string): void;
    deepStrictEqual(actual: any, expected: any, message?: string): void;
    notDeepStrictEqual(actual: any, expected: any, message?: string): void;
    ok(value: any, message?: string): void;
    throws(fn: () => void, error?: any, message?: string): void;
    rejects(fn: () => Promise<any>, error?: any, message?: string): Promise<void>;
  }
  const assert: Assert;
  export default assert;
}

declare module 'node:crypto' {
  const crypto: any;
  export default crypto;
}
