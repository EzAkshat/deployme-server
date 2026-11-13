import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prisma } from '../src/config/database.js';

test('Prisma connects to PostgreSQL and can execute a query', async () => {
  try {
    await prisma.$connect();

    const result = await prisma.$queryRaw<
      { current_database: string }[]
    >`SELECT current_database()`;

    assert.equal(result.length, 1);
    assert.ok(result[0]?.current_database);
  } finally {
    await prisma.$disconnect();
  }
});
