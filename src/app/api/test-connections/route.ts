import { NextResponse } from 'next/server';
import { testConnection } from '@/lib/shopify';
import { testOpenAIConnection } from '@/lib/openai';
import { testBraveConnection } from '@/lib/brave';

export const dynamic = 'force-dynamic';

export async function GET() {
  const [shopify, openai, brave] = await Promise.all([
    testConnection(),
    testOpenAIConnection(),
    testBraveConnection(),
  ]);

  return NextResponse.json({
    shopify,
    openai,
    brave,
    allConnected: shopify.success && openai.success && brave.success,
  });
}
