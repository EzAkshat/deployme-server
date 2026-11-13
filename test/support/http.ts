import assert from 'node:assert/strict';
import type { Response } from 'supertest';

/** Asserts the status code and prints the response body when it does not match. */
export function expectStatus(response: Response, status: number, action = 'Request'): void {
  assert.equal(
    response.status,
    status,
    `${action} should return ${status} but returned ${response.status}: ${JSON.stringify(response.body)}`,
  );
}

/** Asserts the API's standard `{ error: { message } }` response. */
export function expectError(response: Response, status: number, message: string): void {
  expectStatus(response, status);
  assert.deepEqual(response.body, { error: { message } });
}
