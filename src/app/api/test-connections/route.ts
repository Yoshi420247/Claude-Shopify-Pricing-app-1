import { NextResponse } from 'next/server';
import { testConnection } from '@/lib/shopify';
import { testOpenAIConnection } from '@/lib/openai';
import { testAnthropicConnection } from '@/lib/anthropic';
import { testBraveConnection } from '@/lib/brave';

export const dynamic = 'force-dynamic';

export async function GET() {
  // Test all connections in parallel
  const [shopify, openai, anthropic, brave] = await Promise.all([
    testConnection(),
    testOpenAIConnection().catch(e => ({
      success: false,
      model: 'gpt-5.2',
      error: e instanceof Error ? e.message : 'Not configured',
    })),
    testAnthropicConnection().catch(e => ({
      success: false,
      model: 'claude-opus-4-5-20251101',
      error: e instanceof Error ? e.message : 'Not configured',
    })),
    testBraveConnection(),
  ]);

  // At least one AI provider should be connected
  const aiConnected = openai.success || anthropic.success;

  return NextResponse.json({
    shopify,
    openai,
    anthropic,
    brave,
    aiConnected,
    allConnected: shopify.success && aiConnected && brave.success,
  });
}
