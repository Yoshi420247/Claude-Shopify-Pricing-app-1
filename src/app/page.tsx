'use client';

import { useEffect, useState } from 'react';
import { useToast } from '@/components/Toast';
import type { DashboardMetrics, ActivityLog } from '@/types';

export default function DashboardPage() {
  const { showToast } = useToast();
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [activity, setActivity] = useState<ActivityLog[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDashboard();
  }, []);

  async function loadDashboard() {
    try {
      const res = await fetch('/api/dashboard');
      const data = await res.json();
      if (data.success) {
        setMetrics(data.metrics);
        setActivity(data.activity || []);
      }
    } catch (e) {
      console.error('Dashboard load error:', e);
    } finally {
      setLoading(false);
    }
  }

  async function syncProducts() {
    setSyncing(true);
    showToast('Syncing products from Shopify...', 'info');
    try {
      const res = await fetch('/api/shopify/sync', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showToast(`Synced ${data.productsCount} products, ${data.variantsCount} variants (${data.costsLoaded} with costs)`, 'success');
        loadDashboard();
      } else {
        showToast(`Sync failed: ${data.error}`, 'error');
      }
    } catch (e) {
      showToast('Sync failed: network error', 'error');
    } finally {
      setSyncing(false);
    }
  }

  function formatTime(iso: string) {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return new Date(iso).toLocaleDateString();
  }

  const marginColor = metrics?.avgMargin
    ? metrics.avgMargin > 25 ? 'text-green-400'
      : metrics.avgMargin > 15 ? 'text-yellow-400'
      : 'text-red-400'
    : '';

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-semibold">Dashboard</h2>
          <button
            onClick={syncProducts}
            disabled={syncing}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-4 py-2 rounded text-sm flex items-center gap-2"
          >
            {syncing ? (
              <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            )}
            Sync from Shopify
          </button>
        </div>

        {/* Metrics */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
            <p className="text-sm text-gray-400 mb-1">Total Products</p>
            <p className="text-2xl font-semibold">{metrics?.totalProducts ?? '—'}</p>
            <p className="text-xs text-gray-500">{metrics?.totalVariants ?? 0} variants</p>
          </div>
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
            <p className="text-sm text-gray-400 mb-1">Average Margin</p>
            <p className={`text-2xl font-semibold ${marginColor}`}>
              {metrics?.avgMargin != null ? metrics.avgMargin.toFixed(1) + '%' : '—'}
            </p>
          </div>
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
            <p className="text-sm text-gray-400 mb-1">Analyzed</p>
            <p className="text-2xl font-semibold">
              {metrics?.analyzedCount ?? 0} of {metrics?.totalVariants ?? 0}
            </p>
            {metrics && metrics.totalVariants > 0 && (
              <p className="text-xs text-gray-500">
                {Math.round((metrics.analyzedCount / metrics.totalVariants) * 100)}% complete
              </p>
            )}
          </div>
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
            <p className="text-sm text-gray-400 mb-1">Pending Updates</p>
            <p className="text-2xl font-semibold text-blue-400">{metrics?.pendingUpdates ?? 0}</p>
          </div>
        </div>

        {/* Action Cards */}
        <div className="grid grid-cols-2 gap-4 mb-6">
          {metrics && metrics.negativeMargins > 0 && (
            <div className="bg-gray-800 border-l-4 border-red-500 rounded-lg p-4">
              <h3 className="font-medium text-red-400">{metrics.negativeMargins} variants losing money</h3>
              <p className="text-sm text-gray-400 mt-1">Current price below cost</p>
              <a href="/products?status=negative_margin" className="mt-3 inline-block px-4 py-2 bg-red-600 hover:bg-red-700 rounded text-sm">
                Review & Fix
              </a>
            </div>
          )}
          {metrics && metrics.belowFloor > 0 && (
            <div className="bg-gray-800 border-l-4 border-yellow-500 rounded-lg p-4">
              <h3 className="font-medium text-yellow-400">{metrics.belowFloor} variants below margin floor</h3>
              <p className="text-sm text-gray-400 mt-1">Below minimum margin target</p>
              <a href="/products?status=below_floor" className="mt-3 inline-block px-4 py-2 bg-yellow-600 hover:bg-yellow-700 rounded text-sm">
                Review
              </a>
            </div>
          )}
          {metrics && metrics.missingCosts > 0 && (
            <div className="bg-gray-800 border-l-4 border-blue-500 rounded-lg p-4">
              <h3 className="font-medium text-blue-400">{metrics.missingCosts} variants missing cost data</h3>
              <p className="text-sm text-gray-400 mt-1">Cannot calculate margins without costs</p>
              <a href="/products?status=missing_cost" className="mt-3 inline-block px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm">
                View
              </a>
            </div>
          )}
          {metrics && metrics.pendingUpdates > 0 && (
            <div className="bg-gray-800 border-l-4 border-green-500 rounded-lg p-4">
              <h3 className="font-medium text-green-400">{metrics.pendingUpdates} price updates ready</h3>
              <p className="text-sm text-gray-400 mt-1">AI suggestions awaiting approval</p>
              <a href="/products?status=has_suggestion" className="mt-3 inline-block px-4 py-2 bg-green-600 hover:bg-green-700 rounded text-sm">
                Review & Apply
              </a>
            </div>
          )}
          {metrics && metrics.totalProducts === 0 && (
            <div className="bg-gray-800 border-l-4 border-gray-500 rounded-lg p-4 col-span-2">
              <h3 className="font-medium text-gray-300">No products loaded</h3>
              <p className="text-sm text-gray-400 mt-1">Click &quot;Sync from Shopify&quot; to import your catalog</p>
            </div>
          )}
        </div>

        {/* Activity Feed */}
        <div className="bg-gray-800 border border-gray-700 rounded-lg">
          <div className="px-4 py-3 border-b border-gray-700">
            <h3 className="font-medium">Recent Activity</h3>
          </div>
          <div className="p-4 max-h-64 overflow-auto">
            {activity.length > 0 ? (
              activity.map(a => (
                <div key={a.id} className="text-sm py-2 border-b border-gray-700 last:border-0">
                  <span className="text-gray-400">{a.message}</span>
                  <span className="text-xs text-gray-600 ml-2">{formatTime(a.created_at)}</span>
                </div>
              ))
            ) : (
              <p className="text-sm text-gray-500">No recent activity</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
