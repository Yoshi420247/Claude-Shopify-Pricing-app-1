'use client';

import { useEffect, useState } from 'react';
import { useToast } from '@/components/Toast';
import type { Settings } from '@/types';

export default function SettingsPage() {
  const { showToast } = useToast();
  const [settings, setSettings] = useState<Partial<Settings>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<{
    shopify: { success: boolean; error?: string };
    openai: { success: boolean; error?: string };
    brave: { success: boolean; error?: string };
  } | null>(null);

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      if (data.success && data.settings) {
        setSettings(data.settings);
      }
    } catch (e) {
      console.error('Settings load error:', e);
    } finally {
      setLoading(false);
    }
  }

  const [dbWarning, setDbWarning] = useState<string | null>(null);

  async function saveSettings() {
    setSaving(true);
    setDbWarning(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          min_margin: settings.min_margin,
          min_margin_dollars: settings.min_margin_dollars,
          clearance_margin: settings.clearance_margin,
          respect_msrp: settings.respect_msrp,
          max_above: settings.max_above,
          max_increase: settings.max_increase,
          max_decrease: settings.max_decrease,
          rounding_style: settings.rounding_style,
          product_niche: settings.product_niche,
          concurrency: settings.concurrency,
          openai_model: settings.openai_model,
          ai_unrestricted: settings.ai_unrestricted,
        }),
      });
      const data = await res.json();
      if (data.success) {
        if (data.warning === 'ai_unrestricted_not_saved') {
          setDbWarning(data.message);
          showToast('Settings saved (with warning)', 'warning');
        } else {
          showToast('Settings saved', 'success');
        }
      } else {
        showToast(`Save failed: ${data.error}`, 'error');
      }
    } catch {
      showToast('Save failed: network error', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function testConnections() {
    setTesting(true);
    setTestResults(null);
    try {
      const res = await fetch('/api/test-connections');
      const data = await res.json();
      setTestResults(data);
    } catch {
      showToast('Connection test failed', 'error');
    } finally {
      setTesting(false);
    }
  }

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings(prev => ({ ...prev, [key]: value }));
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-3xl mx-auto">
        <h2 className="text-2xl font-semibold mb-6">Settings</h2>

        {/* API Configuration Notice */}
        <div className="bg-blue-900/20 border border-blue-800 rounded-lg p-4 mb-6">
          <h3 className="font-medium text-blue-400 mb-2">API Keys</h3>
          <p className="text-sm text-gray-300">
            API keys are configured via environment variables for security. Set them in your Vercel project settings or <code className="bg-gray-700 px-1 rounded">.env.local</code> file:
          </p>
          <ul className="text-sm text-gray-400 mt-2 space-y-1 font-mono">
            <li>SHOPIFY_STORE_NAME, SHOPIFY_ACCESS_TOKEN</li>
            <li>OPENAI_API_KEY</li>
            <li>BRAVE_API_KEY</li>
            <li>NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY</li>
          </ul>
        </div>

        {/* Test Connections */}
        <div className="bg-gray-800 border border-gray-700 rounded-lg mb-6">
          <div className="px-4 py-3 border-b border-gray-700">
            <h3 className="font-medium">Connection Status</h3>
          </div>
          <div className="p-4">
            <button onClick={testConnections} disabled={testing}
              className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 px-4 py-2 rounded text-sm mb-3">
              {testing ? 'Testing...' : 'Test All Connections'}
            </button>
            {testResults && (
              <div className="space-y-2">
                {(['shopify', 'openai', 'brave'] as const).map(key => {
                  const r = testResults[key];
                  return (
                    <p key={key} className={`text-sm ${r.success ? 'text-green-400' : 'text-red-400'}`}>
                      {r.success ? '✓' : '✗'} {key.charAt(0).toUpperCase() + key.slice(1)}: {r.success ? 'Connected' : r.error || 'Failed'}
                    </p>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Database Warning */}
        {dbWarning && (
          <div className="bg-yellow-900/30 border border-yellow-700 rounded-lg p-4 mb-6">
            <div className="flex items-start gap-3">
              <span className="text-yellow-500 text-xl">⚠️</span>
              <div>
                <h4 className="font-medium text-yellow-400">Database Column Missing</h4>
                <p className="text-sm text-yellow-200/80 mt-1">{dbWarning}</p>
                <code className="block mt-2 bg-gray-800 text-green-400 p-2 rounded text-xs font-mono">
                  ALTER TABLE settings ADD COLUMN ai_unrestricted BOOLEAN DEFAULT false;
                </code>
                <p className="text-xs text-gray-400 mt-2">Run this SQL in your Supabase SQL Editor, then refresh this page.</p>
              </div>
            </div>
          </div>
        )}

        {/* AI Mode Selection */}
        <div className={`border rounded-lg mb-6 ${settings.ai_unrestricted ? 'bg-purple-900/30 border-purple-700' : 'bg-gray-800 border-gray-700'}`}>
          <div className="px-4 py-3 border-b border-gray-700">
            <h3 className="font-medium">AI Pricing Mode</h3>
            <p className="text-xs text-gray-500">Choose how the AI calculates prices</p>
          </div>
          <div className="p-4 space-y-4">
            {/* AI Unrestricted Mode Toggle */}
            <div className={`p-4 rounded-lg border ${settings.ai_unrestricted ? 'bg-purple-900/40 border-purple-600' : 'bg-gray-700/50 border-gray-600'}`}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-lg">🧠</span>
                    <label className="font-medium text-white">AI Unrestricted Mode</label>
                    {settings.ai_unrestricted && (
                      <span className="px-2 py-0.5 bg-purple-600 text-purple-100 text-xs rounded font-medium">ACTIVE</span>
                    )}
                  </div>
                  <p className="text-sm text-gray-400 mt-1">
                    {settings.ai_unrestricted
                      ? 'AI will give its best expert recommendation without any constraints'
                      : 'Enable to let AI freely determine optimal price without guardrails'
                    }
                  </p>
                </div>
                <button onClick={() => update('ai_unrestricted', !settings.ai_unrestricted)}
                  className={`relative w-14 h-7 rounded-full transition-colors ${settings.ai_unrestricted ? 'bg-purple-600' : 'bg-gray-600'}`}>
                  <span className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-transform ${settings.ai_unrestricted ? 'left-8' : 'left-1'}`} />
                </button>
              </div>
              {settings.ai_unrestricted && (
                <div className="mt-3 p-3 bg-purple-900/30 border border-purple-700 rounded text-sm">
                  <p className="text-purple-300 font-medium">When enabled:</p>
                  <ul className="text-purple-200/80 mt-1 space-y-1 text-xs">
                    <li>• No minimum margin requirements</li>
                    <li>• No MSRP ceiling</li>
                    <li>• No competitor price limits</li>
                    <li>• No price change restrictions</li>
                    <li>• AI uses pure market expertise</li>
                  </ul>
                </div>
              )}
            </div>

            {/* Model Selection */}
            <div>
              <label className="block text-sm text-gray-400 mb-2">AI Model</label>
              <select value={settings.openai_model || 'gpt-5.2'}
                onChange={e => update('openai_model', e.target.value)}
                className="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm w-full">
                <option value="gpt-5.2">GPT-5.2 (Recommended)</option>
                <option value="gpt-5.2-pro">GPT-5.2 Pro (Highest accuracy)</option>
                <option value="gpt-5.1">GPT-5.1</option>
                <option value="gpt-4o">GPT-4o (Legacy)</option>
              </select>
            </div>
          </div>
        </div>

        {/* Pricing Rules */}
        <div className="bg-gray-800 border border-gray-700 rounded-lg mb-6">
          <div className="px-4 py-3 border-b border-gray-700">
            <h3 className="font-medium">Pricing Rules</h3>
            <p className="text-xs text-gray-500">The AI uses these as guardrails</p>
          </div>
          <div className="p-4 space-y-6">
            {/* Margin Floors */}
            <div>
              <h4 className="text-sm font-medium text-gray-300 mb-3">Margin Floors</h4>
              <div className="space-y-4">
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <label className="text-gray-400">Minimum Margin %</label>
                    <span className="text-white">{settings.min_margin ?? 20}%</span>
                  </div>
                  <input type="range" min={0} max={50} value={settings.min_margin ?? 20}
                    onChange={e => update('min_margin', Number(e.target.value))}
                    className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Minimum Margin $</label>
                  <input type="number" step={0.5} min={0} value={settings.min_margin_dollars ?? 3}
                    onChange={e => update('min_margin_dollars', Number(e.target.value))}
                    className="w-32 bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm" />
                </div>
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <label className="text-gray-400">Clearance Minimum Margin %</label>
                    <span className="text-white">{settings.clearance_margin ?? 5}%</span>
                  </div>
                  <input type="range" min={0} max={20} value={settings.clearance_margin ?? 5}
                    onChange={e => update('clearance_margin', Number(e.target.value))}
                    className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer" />
                </div>
              </div>
            </div>

            {/* Price Ceilings */}
            <div>
              <h4 className="text-sm font-medium text-gray-300 mb-3">Price Ceilings</h4>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <label className="text-sm text-gray-400">Never exceed MSRP</label>
                  <button onClick={() => update('respect_msrp', !settings.respect_msrp)}
                    className={`relative w-11 h-6 rounded-full transition-colors ${settings.respect_msrp ? 'bg-blue-600' : 'bg-gray-600'}`}>
                    <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-transform ${settings.respect_msrp ? 'left-5' : 'left-0.5'}`} />
                  </button>
                </div>
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <label className="text-gray-400">Max % above highest competitor</label>
                    <span className="text-white">{settings.max_above ?? 5}%</span>
                  </div>
                  <input type="range" min={0} max={25} value={settings.max_above ?? 5}
                    onChange={e => update('max_above', Number(e.target.value))}
                    className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer" />
                </div>
              </div>
            </div>

            {/* Price Change Governance */}
            <div>
              <h4 className="text-sm font-medium text-gray-300 mb-3">Price Change Governance</h4>
              <div className="space-y-4">
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <label className="text-gray-400">Max single increase %</label>
                    <span className="text-white">{settings.max_increase ?? 10}%</span>
                  </div>
                  <input type="range" min={1} max={25} value={settings.max_increase ?? 10}
                    onChange={e => update('max_increase', Number(e.target.value))}
                    className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer" />
                </div>
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <label className="text-gray-400">Max single decrease %</label>
                    <span className="text-white">{settings.max_decrease ?? 15}%</span>
                  </div>
                  <input type="range" min={1} max={30} value={settings.max_decrease ?? 15}
                    onChange={e => update('max_decrease', Number(e.target.value))}
                    className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer" />
                </div>
              </div>
            </div>

            {/* Rounding */}
            <div>
              <h4 className="text-sm font-medium text-gray-300 mb-3">Rounding</h4>
              <select value={settings.rounding_style || 'psychological'}
                onChange={e => update('rounding_style', e.target.value as Settings['rounding_style'])}
                className="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm">
                <option value="psychological">Psychological (.99 endings)</option>
                <option value="clean">Clean (.00 endings)</option>
                <option value="none">No rounding</option>
              </select>
            </div>
          </div>
        </div>

        {/* Store Context */}
        <div className="bg-gray-800 border border-gray-700 rounded-lg mb-6">
          <div className="px-4 py-3 border-b border-gray-700">
            <h3 className="font-medium">Store Context</h3>
          </div>
          <div className="p-4">
            <label className="block text-sm text-gray-400 mb-1">Product Niche & Context</label>
            <textarea rows={3} value={settings.product_niche || ''}
              onChange={e => update('product_niche', e.target.value)}
              placeholder="e.g., Heady glass, American-made dab tools, concentrate accessories..."
              className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm" />
            <p className="text-xs text-gray-500 mt-1">The AI uses this for better search queries and competitor evaluation</p>
          </div>
        </div>

        {/* Processing */}
        <div className="bg-gray-800 border border-gray-700 rounded-lg mb-6">
          <div className="px-4 py-3 border-b border-gray-700">
            <h3 className="font-medium">Processing</h3>
          </div>
          <div className="p-4">
            <div className="flex justify-between text-sm mb-1">
              <label className="text-gray-400">Parallel Operations</label>
              <span className="text-white">{settings.concurrency ?? 20}</span>
            </div>
            <input type="range" min={1} max={30} value={settings.concurrency ?? 20}
              onChange={e => update('concurrency', Number(e.target.value))}
              className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer" />
          </div>
        </div>

        <button onClick={saveSettings} disabled={saving}
          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-6 py-2 rounded text-sm font-medium">
          {saving ? 'Saving...' : 'Save All Settings'}
        </button>
      </div>
    </div>
  );
}
