import { NextResponse } from 'next/server';
import { testConnection } from '@/lib/shopify';
import { testOpenAIConnection } from '@/lib/openai';
import { testBraveConnection } from '@/lib/brave';
import { testClaudeConnection } from '@/lib/claude';
import { testGeminiConnection } from '@/lib/gemini';

export const dynamic = 'force-dynamic';

export async function GET() {
  const [shopify, openai, brave, claude, gemini] = await Promise.all([
    testConnection(),
    testOpenAIConnection(),
    testBraveConnection(),
    testClaudeConnection(),
    testGeminiConnection(),
  ]);

  // Core services must be connected; AI providers are optional (at least one needed)
  const coreConnected = shopify.success && openai.success;
  const anyAIConnected = openai.success || claude.success || gemini.success;

  return NextResponse.json({
    shopify,
    openai,
    brave,
    claude,
    gemini,
    allConnected: coreConnected && brave.success && anyAIConnected,
    coreConnected,
    anyAIConnected,
  });
}
