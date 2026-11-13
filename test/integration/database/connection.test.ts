import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { prisma } from '../../../src/config/database.js';
import { disconnectPrismaAfterAll } from '../../support/test-data.js';

describe('database connection', () => {
  disconnectPrismaAfterAll();

  it('connects to PostgreSQL and can execute a query', async () => {
    await prisma.$connect();

    const result = await prisma.$queryRaw<
      { current_database: string }[]
    >`SELECT current_database()`;

    assert.equal(result.length, 1);
    assert.ok(result[0]?.current_database);
  });
});
