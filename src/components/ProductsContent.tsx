'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useToast } from '@/components/Toast';
import ProductModal from '@/components/ProductModal';
import type { Product, Variant, Analysis, Settings } from '@/types';

interface VariantRow extends Variant {
  product: Product;
  analysis: Analysis | null;
}

interface BatchJob {
  id: string;
  name: string;
  totalVariants: number;
  chunkSize: number;
  autoApply: boolean;
  aiUnrestricted: boolean;
  completed: number;
  failed: number;
  applied: number;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'cancelled';
  currentChunk: number;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

const defaultSettings: Partial<Settings> = {
  min_margin: 20,
  min_margin_dollars: 3,
  respect_msrp: true,
  max_above: 5,
  max_increase: 10,
  max_decrease: 15,
  rounding_style: 'psychological',
  ai_unrestricted: false,
};

export default function ProductsContent() {
  const { showToast } = useToast();
  const searchParams = useSearchParams();

  const [rows, setRows] = useState<VariantRow[]>([]);
  const [filtered, setFiltered] = useState<VariantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') || '');
  const [productStatusFilter, setProductStatusFilter] = useState('');
  const [vendorFilter, setVendorFilter] = useState('');
  const [sortBy, setSortBy] = useState('name-asc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [analyzing, setAnalyzing] = useState<Set<string>>(new Set());
  const [modalVariant, setModalVariant] = useState<VariantRow | null>(null);
  const [settings, setSettings] = useState<Partial<Settings>>(defaultSettings);

  // Persistent batch state
  const [activeBatch, setActiveBatch] = useState<BatchJob | null>(null);
  const [batchProcessing, setBatchProcessing] = useState(false);
  const cancelBatchRef = useRef(false);
  const [applying, setApplying] = useState(false);

  // Batch creation options
  const [showBatchConfig, setShowBatchConfig] = useState(false);
  const [batchAutoApply, setBatchAutoApply] = useState(false);
  const [batchAiUnrestricted, setBatchAiUnrestricted] = useState(false);
  const [batchChunkSize, setBatchChunkSize] = useState(50);

  const vendors = [...new Set(rows.map(r => r.product.vendor).filter(Boolean))] as string[];

  // Load settings
  useEffect(() => {
    async function loadSettings() {
      try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        if (data.success && data.settings) {
          const merged = { ...defaultSettings, ...data.settings };
          const storedUnrestricted = localStorage.getItem('ai_unrestricted');
          if (storedUnrestricted !== null) {
            merged.ai_unrestricted = storedUnrestricted === 'true';
          }
          setSettings(merged);
        }
      } catch (e) {
        console.error('Settings load error:', e);
      }
    }
    loadSettings();
  }, []);

  // Check for active batch on page load (resume detection)
  useEffect(() => {
    async function checkActiveBatch() {
      try {
        const res = await fetch('/api/batch');
        const data = await res.json();
        if (data.success && data.hasActiveBatch && data.batch) {
          setActiveBatch(data.batch);
          // Auto-resume if batch is running
          if (data.batch.status === 'running' || data.batch.status === 'pending') {
            resumeBatchProcessing(data.batch.id);
          }
        } else if (data.success && data.batch && data.batch.status === 'completed') {
          // Show completed batch so user can apply results
          setActiveBatch(data.batch);
        }
      } catch (e) {
        console.error('Batch check error:', e);
      }
    }
    checkActiveBatch();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load all products + variants + analyses
  const loadData = useCallback(async () => {
    try {
      let allProducts: Product[] = [];
      let pg = 0;
      const pgSize = 1000;

      while (true) {
        const { data: products, error } = await supabase
          .from('products')
          .select('*')
          .order('title')
          .range(pg * pgSize, (pg + 1) * pgSize - 1);

        if (error) { console.error('Products fetch error:', error); break; }
        if (!products || products.length === 0) break;
        allProducts = [...allProducts, ...(products as Product[])];
        if (products.length < pgSize) break;
        pg++;
        if (pg > 50) break;
      }

      let allVariants: Variant[] = [];
      pg = 0;
      while (true) {
        const { data: variants, error } = await supabase
          .from('variants')
          .select('*')
          .range(pg * pgSize, (pg + 1) * pgSize - 1);

        if (error) { console.error('Variants fetch error:', error); break; }
        if (!variants || variants.length === 0) break;
        allVariants = [...allVariants, ...(variants as Variant[])];
        if (variants.length < pgSize) break;
        pg++;
        if (pg > 50) break;
      }

      let allAnalyses: Analysis[] = [];
      pg = 0;
      while (true) {
        const { data: analyses, error } = await supabase
          .from('analyses')
          .select('*')
          .range(pg * pgSize, (pg + 1) * pgSize - 1);

        if (error) { console.error('Analyses fetch error:', error); break; }
        if (!analyses || analyses.length === 0) break;
        allAnalyses = [...allAnalyses, ...(analyses as Analysis[])];
        if (analyses.length < pgSize) break;
        pg++;
        if (pg > 50) break;
      }

      const productMap = new Map(allProducts.map(p => [p.id, p]));
      const analysisMap = new Map(allAnalyses.map(a => [a.variant_id, a]));

      const variantRows: VariantRow[] = allVariants.map(v => ({
        ...(v as Variant),
        product: productMap.get(v.product_id) as Product,
        analysis: analysisMap.get(v.id) || null,
      })).filter(v => v.product);

      setRows(variantRows);
    } catch (e) {
      console.error('Load error:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Filter and sort
  useEffect(() => {
    let result = [...rows];

    if (search) {
      const q = search.toLowerCase();
      result = result.filter(r =>
        r.product.title.toLowerCase().includes(q) ||
        r.product.vendor?.toLowerCase().includes(q) ||
        r.sku?.toLowerCase().includes(q) ||
        r.title?.toLowerCase().includes(q)
      );
    }

    if (vendorFilter) {
      result = result.filter(r => r.product.vendor === vendorFilter);
    }

    if (productStatusFilter) {
      result = result.filter(r => r.product.status === productStatusFilter);
    }

    if (statusFilter) {
      result = result.filter(r => {
        const a = r.analysis;
        const margin = r.cost ? ((r.price - r.cost) / r.price) * 100 : null;
        switch (statusFilter) {
          case 'needs_analysis': return !a;
          case 'has_suggestion': return a && a.suggested_price && !a.applied && !a.error;
          case 'applied': return a?.applied;
          case 'failed': return a?.error;
          case 'negative_margin': return margin !== null && margin < 0;
          case 'below_floor': return margin !== null && margin >= 0 && margin < (settings.min_margin ?? 20);
          case 'missing_cost': return !r.cost;
          default: return true;
        }
      });
    }

    result.sort((a, b) => {
      switch (sortBy) {
        case 'name-asc': return a.product.title.localeCompare(b.product.title);
        case 'name-desc': return b.product.title.localeCompare(a.product.title);
        case 'price-asc': return a.price - b.price;
        case 'price-desc': return b.price - a.price;
        case 'margin-asc': {
          const am = a.cost ? (a.price - a.cost) / a.price : -999;
          const bm = b.cost ? (b.price - b.cost) / b.price : -999;
          return am - bm;
        }
        case 'margin-desc': {
          const am = a.cost ? (a.price - a.cost) / a.price : -999;
          const bm = b.cost ? (b.price - b.cost) / b.price : -999;
          return bm - am;
        }
        default: return 0;
      }
    });

    setFiltered(result);
    setPage(1);
  }, [rows, search, statusFilter, productStatusFilter, vendorFilter, sortBy, settings.min_margin]);

  const totalPages = Math.ceil(filtered.length / pageSize);
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);

  // Analyze a single variant
  async function analyzeVariant(productId: string, variantId: string, opts?: { silent?: boolean }): Promise<boolean> {
    const key = `${productId}:${variantId}`;
    setAnalyzing(prev => new Set(prev).add(key));

    try {
      const res = await fetch('/api/analysis/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, variantId, ai_unrestricted: settings.ai_unrestricted }),
      });
      const data = await res.json();
      if (data.success) {
        if (!opts?.silent) {
          showToast('Analysis complete', 'success');
          loadData();
        }
        return true;
      } else {
        if (!opts?.silent) showToast(`Analysis failed: ${data.error}`, 'error');
        return false;
      }
    } catch {
      if (!opts?.silent) showToast('Analysis failed: network error', 'error');
      return false;
    } finally {
      setAnalyzing(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  // Accept a suggestion
  async function acceptSuggestion(analysisId: string) {
    try {
      const res = await fetch('/api/analysis/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ analysisId }),
      });
      const data = await res.json();
      if (data.success) {
        showToast('Price updated on Shopify', 'success');
        loadData();
      } else {
        showToast(`Failed: ${data.error}`, 'error');
      }
    } catch {
      showToast('Failed: network error', 'error');
    }
  }

  // ========================================================================
  // PERSISTENT BATCH SYSTEM
  // ========================================================================

  // Create a new batch job
  async function createBatch(items: VariantRow[]) {
    if (batchProcessing || activeBatch?.status === 'running') return;

    const variantIds = items.map(r => ({ productId: r.product_id, variantId: r.id }));

    try {
      const res = await fetch('/api/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variantIds,
          chunkSize: batchChunkSize,
          autoApply: batchAutoApply,
          aiUnrestricted: batchAiUnrestricted,
          name: `Batch: ${items.length} variants`,
        }),
      });
      const data = await res.json();
      if (data.success && data.batch) {
        setActiveBatch(data.batch);
        setShowBatchConfig(false);
        showToast(`Batch created: ${items.length} variants`, 'success');
        // Start processing
        resumeBatchProcessing(data.batch.id);
      } else {
        showToast(`Failed to create batch: ${data.error}`, 'error');
      }
    } catch {
      showToast('Failed to create batch: network error', 'error');
    }
  }

  // Resume processing a batch (called on page load if batch exists, or after creation)
  async function resumeBatchProcessing(batchId: string) {
    if (batchProcessing) return;
    setBatchProcessing(true);
    cancelBatchRef.current = false;

    try {
      while (!cancelBatchRef.current) {
        const res = await fetch('/api/batch/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batchId }),
        });
        const data = await res.json();

        if (!data.success) {
          console.error('Batch process error:', data.error);
          // Wait and retry
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }

        // Update batch state
        if (data.batch) {
          setActiveBatch(data.batch);
        }

        // Check if done
        if (data.done) {
          showToast(
            data.reason === 'cancelled'
              ? 'Batch cancelled. Progress saved.'
              : `Batch complete! ${data.batch?.completed || 0} analyzed${data.batch?.autoApply ? `, ${data.batch?.applied || 0} applied` : ''}`,
            data.reason === 'cancelled' ? 'warning' : 'success'
          );
          // Reload data to show results
          loadData();
          break;
        }

        // Reload data periodically to update table
        loadData();

        // Small delay between chunks to not hammer the server
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (e) {
      console.error('Batch processing error:', e);
      showToast('Batch processing interrupted. Refresh to resume.', 'warning');
    } finally {
      setBatchProcessing(false);
    }
  }

  // Cancel active batch
  async function cancelBatch() {
    if (!activeBatch) return;
    cancelBatchRef.current = true;

    try {
      await fetch('/api/batch/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId: activeBatch.id }),
      });
      setActiveBatch(prev => prev ? { ...prev, status: 'cancelled' } : null);
      showToast('Batch cancelled. Progress saved.', 'warning');
      loadData();
    } catch {
      showToast('Failed to cancel batch', 'error');
    }
  }

  // Apply all results from a completed batch
  async function applyBatchResults() {
    if (!activeBatch || applying) return;
    setApplying(true);

    try {
      const res = await fetch('/api/batch/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId: activeBatch.id }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(`Applied ${data.applied} prices to Shopify${data.failed > 0 ? ` (${data.failed} failed)` : ''}`, 'success');
        setActiveBatch(prev => prev ? { ...prev, applied: (prev.applied || 0) + data.applied } : null);
        loadData();
      } else {
        showToast(`Apply failed: ${data.error}`, 'error');
      }
    } catch {
      showToast('Apply failed: network error', 'error');
    } finally {
      setApplying(false);
    }
  }

  // Dismiss completed/cancelled batch
  function dismissBatch() {
    setActiveBatch(null);
  }

  // Select all filtered variants
  function selectAllFiltered() {
    setSelected(new Set(filtered.map(r => r.id)));
  }

  // Open batch config for selected items
  function openBatchConfig() {
    if (selected.size === 0 && filtered.length === 0) return;
    setShowBatchConfig(true);
  }

  // Start batch for selected or all filtered
  function startBatch(useSelected: boolean) {
    const items = useSelected
      ? rows.filter(r => selected.has(r.id))
      : filtered;
    if (items.length === 0) return;
    createBatch(items);
  }

  // CSV export
  function exportCSV() {
    const headers = ['Product', 'Variant', 'Vendor', 'SKU', 'Price', 'Cost', 'Margin %', 'Suggested', 'Confidence', 'Status'];
    const csvRows = filtered.map(r => {
      const margin = r.cost ? ((r.price - r.cost) / r.price * 100).toFixed(1) : '';
      const status = r.analysis?.applied ? 'Applied' : r.analysis?.suggested_price ? 'Has Suggestion' : r.analysis?.error ? 'Failed' : 'Needs Analysis';
      return [
        r.product.title, r.title || 'Default', r.product.vendor || '', r.sku || '',
        r.price.toFixed(2), r.cost?.toFixed(2) || '', margin,
        r.analysis?.suggested_price?.toFixed(2) || '', r.analysis?.confidence || '', status,
      ];
    });
    const csv = [headers, ...csvRows].map(row => row.map(c => `"${c}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pricing-export-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  const selectedCount = selected.size;
  const hasSelectedSuggestions = [...selected].some(id => {
    const r = rows.find(r => r.id === id);
    return r?.analysis?.suggested_price && !r.analysis.applied;
  });

  const batchDone = activeBatch && (activeBatch.status === 'completed' || activeBatch.status === 'cancelled');
  const batchActive = activeBatch && (activeBatch.status === 'running' || activeBatch.status === 'pending');
  const batchProgress = activeBatch ? ((activeBatch.completed + activeBatch.failed) / Math.max(activeBatch.totalVariants, 1)) * 100 : 0;

  return (
    <>
      {/* ================================================================ */}
      {/* PERSISTENT BATCH PROGRESS BAR - survives page refreshes */}
      {/* ================================================================ */}
      {activeBatch && (
        <div className={`border-b shadow-lg ${
          batchActive ? 'bg-gray-900 border-blue-500/50 shadow-blue-500/10' :
          activeBatch.status === 'completed' ? 'bg-gray-900 border-green-500/50 shadow-green-500/10' :
          'bg-gray-900 border-yellow-500/50 shadow-yellow-500/10'
        }`}>
          {/* Progress bar track */}
          <div className="h-1.5 bg-gray-800 relative overflow-hidden">
            <div
              className={`h-full transition-all duration-500 ease-out relative ${
                batchActive ? 'bg-gradient-to-r from-blue-600 to-blue-400 progress-bar-shimmer' :
                activeBatch.status === 'completed' ? 'bg-gradient-to-r from-green-600 to-green-400' :
                'bg-gradient-to-r from-yellow-600 to-yellow-400'
              }`}
              style={{ width: `${Math.max(1, batchProgress)}%` }}
            />
          </div>

          <div className="px-6 py-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                {batchActive && (
                  <div className="relative">
                    <div className="animate-spin w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full" />
                    <div className="absolute inset-0 animate-ping w-6 h-6 border border-blue-400/30 rounded-full" />
                  </div>
                )}
                {activeBatch.status === 'completed' && (
                  <div className="w-6 h-6 bg-green-500 rounded-full flex items-center justify-center">
                    <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                )}
                <div>
                  <div className="font-medium text-sm flex items-center gap-3">
                    <span>
                      {batchActive ? 'Analyzing' : activeBatch.status === 'completed' ? 'Batch Complete' : 'Batch Cancelled'}
                      {' '}{activeBatch.completed + activeBatch.failed} / {activeBatch.totalVariants} variants
                    </span>
                    <span className="text-xs text-gray-500">({Math.round(batchProgress)}%)</span>
                    {activeBatch.autoApply && (
                      <span className="text-xs px-2 py-0.5 bg-purple-900/50 text-purple-300 rounded">Auto-Apply</span>
                    )}
                    {activeBatch.aiUnrestricted && (
                      <span className="text-xs px-2 py-0.5 bg-orange-900/50 text-orange-300 rounded">AI Unlimited</span>
                    )}
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5 flex items-center gap-3">
                    <span className="text-green-400">{activeBatch.completed} completed</span>
                    {activeBatch.failed > 0 && <span className="text-red-400">{activeBatch.failed} failed</span>}
                    {activeBatch.applied > 0 && <span className="text-purple-400">{activeBatch.applied} applied</span>}
                    <span className="text-gray-500">Chunk size: {activeBatch.chunkSize}</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {/* Apply button for completed non-auto-apply batches */}
                {batchDone && !activeBatch.autoApply && activeBatch.completed > 0 && (
                  <button
                    onClick={applyBatchResults}
                    disabled={applying}
                    className="px-4 py-1.5 bg-green-600 hover:bg-green-700 disabled:opacity-50 rounded text-sm font-medium transition-colors flex items-center gap-2"
                  >
                    {applying ? (
                      <>
                        <div className="animate-spin w-3 h-3 border-2 border-white border-t-transparent rounded-full" />
                        Applying...
                      </>
                    ) : (
                      <>Apply All Suggestions</>
                    )}
                  </button>
                )}

                {/* Cancel button for active batches */}
                {batchActive && (
                  <button
                    onClick={cancelBatch}
                    className="px-4 py-1.5 bg-red-600/80 hover:bg-red-600 rounded text-sm font-medium transition-colors"
                  >
                    Cancel
                  </button>
                )}

                {/* Dismiss button for finished batches */}
                {batchDone && (
                  <button
                    onClick={dismissBatch}
                    className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm transition-colors"
                  >
                    Dismiss
                  </button>
                )}
              </div>
            </div>

            {/* Show last error if any */}
            {activeBatch.lastError && batchActive && (
              <div className="mt-2 text-xs text-yellow-400/70 truncate">
                Last issue: {activeBatch.lastError}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ================================================================ */}
      {/* BATCH CONFIGURATION MODAL */}
      {/* ================================================================ */}
      {showBatchConfig && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setShowBatchConfig(false)}>
          <div className="bg-gray-800 border border-gray-700 rounded-xl shadow-2xl w-full max-w-lg" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-gray-700">
              <h3 className="text-lg font-semibold">Batch Analysis Configuration</h3>
              <p className="text-sm text-gray-400 mt-1">
                {selectedCount > 0 ? `${selectedCount} selected variants` : `${filtered.length} filtered variants`}
              </p>
            </div>

            <div className="p-6 space-y-5">
              {/* Chunk size */}
              <div>
                <div className="flex justify-between text-sm mb-1">
                  <label className="text-gray-300 font-medium">Chunk Size</label>
                  <span className="text-gray-400">{batchChunkSize} variants per batch</span>
                </div>
                <input
                  type="range" min={10} max={200} step={10} value={batchChunkSize}
                  onChange={e => setBatchChunkSize(Number(e.target.value))}
                  className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Work is saved after each chunk completes. Smaller chunks = more frequent saves.
                </p>
              </div>

              {/* AI Unlimited Mode */}
              <label className="flex items-start gap-3 p-3 bg-gray-700/50 rounded-lg cursor-pointer hover:bg-gray-700/70 transition-colors">
                <input
                  type="checkbox"
                  checked={batchAiUnrestricted}
                  onChange={e => setBatchAiUnrestricted(e.target.checked)}
                  className="mt-0.5 rounded bg-gray-600 border-gray-500"
                />
                <div>
                  <div className="text-sm font-medium text-orange-300">AI Unlimited Mode</div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    AI decides optimal price without margin floors, MSRP limits, or price change caps.
                    Best expert recommendation with no guardrails.
                  </div>
                </div>
              </label>

              {/* Auto Apply */}
              <label className="flex items-start gap-3 p-3 bg-gray-700/50 rounded-lg cursor-pointer hover:bg-gray-700/70 transition-colors">
                <input
                  type="checkbox"
                  checked={batchAutoApply}
                  onChange={e => setBatchAutoApply(e.target.checked)}
                  className="mt-0.5 rounded bg-gray-600 border-gray-500"
                />
                <div>
                  <div className="text-sm font-medium text-purple-300">Auto-Apply to Shopify</div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    Automatically update prices on Shopify as each analysis completes.
                    No manual review needed &mdash; the AI decides and applies.
                  </div>
                </div>
              </label>

              {/* Warning for auto-apply + unrestricted */}
              {batchAutoApply && batchAiUnrestricted && (
                <div className="p-3 bg-red-900/30 border border-red-700/50 rounded-lg">
                  <div className="text-sm font-medium text-red-300">Full Autopilot Mode</div>
                  <div className="text-xs text-gray-300 mt-1">
                    The AI will analyze every product, determine the best price with no constraints,
                    and immediately update Shopify. You can cancel at any time and all progress is saved.
                  </div>
                </div>
              )}

              {/* Summary */}
              <div className="p-3 bg-gray-700/30 rounded-lg text-sm text-gray-300">
                <div className="font-medium mb-1">Summary</div>
                <ul className="text-xs space-y-1 text-gray-400">
                  <li>{selectedCount > 0 ? selectedCount : filtered.length} variants will be analyzed</li>
                  <li>Processed in chunks of {batchChunkSize} (saved after each chunk)</li>
                  <li>{Math.ceil((selectedCount > 0 ? selectedCount : filtered.length) / batchChunkSize)} total chunks</li>
                  {batchAiUnrestricted && <li className="text-orange-400">AI decides all prices (no guardrails)</li>}
                  {batchAutoApply && <li className="text-purple-400">Prices auto-applied to Shopify</li>}
                  {!batchAutoApply && <li>You will review and apply prices after completion</li>}
                </ul>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-gray-700 flex justify-end gap-3">
              <button
                onClick={() => setShowBatchConfig(false)}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm"
              >
                Cancel
              </button>
              <button
                onClick={() => startBatch(selectedCount > 0)}
                className="px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm font-medium flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                Start Batch Analysis
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================================================================ */}
      {/* FILTER BAR */}
      {/* ================================================================ */}
      <div className="bg-gray-800 border-b border-gray-700 p-4 flex items-center gap-4 flex-wrap">
        <input
          type="text"
          placeholder="Search products, SKUs, vendors..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 min-w-[200px] max-w-md bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
        />
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm">
          <option value="">All Status</option>
          <option value="needs_analysis">Needs Analysis</option>
          <option value="has_suggestion">Has Suggestion</option>
          <option value="applied">Applied</option>
          <option value="failed">Failed</option>
          <option value="negative_margin">Negative Margin</option>
          <option value="below_floor">Below Floor</option>
          <option value="missing_cost">Missing Cost</option>
        </select>
        <select value={productStatusFilter} onChange={e => setProductStatusFilter(e.target.value)}
          className="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm">
          <option value="">All Products</option>
          <option value="active">Active Only</option>
          <option value="draft">Draft Only</option>
          <option value="archived">Archived Only</option>
        </select>
        <select value={vendorFilter} onChange={e => setVendorFilter(e.target.value)}
          className="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm">
          <option value="">All Vendors</option>
          {vendors.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        <select value={sortBy} onChange={e => setSortBy(e.target.value)}
          className="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm">
          <option value="name-asc">Name A-Z</option>
          <option value="name-desc">Name Z-A</option>
          <option value="price-asc">Price: Low-High</option>
          <option value="price-desc">Price: High-Low</option>
          <option value="margin-asc">Margin: Low-High</option>
          <option value="margin-desc">Margin: High-Low</option>
        </select>

        {/* Batch analyze button */}
        <button
          onClick={openBatchConfig}
          disabled={!!batchActive}
          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 rounded text-sm flex items-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
          </svg>
          {selectedCount > 0 ? `Batch Analyze (${selectedCount})` : `Batch Analyze All (${filtered.length})`}
        </button>

        <button onClick={exportCSV}
          className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded text-sm">
          Export CSV
        </button>
      </div>

      {/* ================================================================ */}
      {/* PRODUCT TABLE */}
      {/* ================================================================ */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-800 sticky top-0">
            <tr className="border-b border-gray-700">
              <th className="w-10 px-4 py-3 text-left">
                <input type="checkbox"
                  checked={selected.size === filtered.length && filtered.length > 0}
                  onChange={e => {
                    if (e.target.checked) selectAllFiltered();
                    else setSelected(new Set());
                  }}
                  className="rounded bg-gray-700 border-gray-600" />
              </th>
              <th className="w-14 px-2 py-3" />
              <th className="px-4 py-3 text-left font-medium text-gray-400">Product / Variant</th>
              <th className="w-28 px-4 py-3 text-left font-medium text-gray-400">SKU</th>
              <th className="w-24 px-4 py-3 text-right font-medium text-gray-400">Price</th>
              <th className="w-24 px-4 py-3 text-right font-medium text-gray-400">Cost</th>
              <th className="w-20 px-4 py-3 text-right font-medium text-gray-400">Margin</th>
              <th className="w-32 px-4 py-3 text-right font-medium text-gray-400">Suggested</th>
              <th className="w-24 px-4 py-3 text-center font-medium text-gray-400">Status</th>
              <th className="w-36 px-4 py-3 text-center font-medium text-gray-400">Actions</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map(row => {
              const margin = row.cost ? ((row.price - row.cost) / row.price) * 100 : null;
              const marginClass = margin === null ? 'text-gray-500'
                : margin < 0 ? 'text-red-400 bg-red-900/20'
                : margin < 15 ? 'text-yellow-400'
                : 'text-green-400';

              const a = row.analysis;
              const isAnalyzing = analyzing.has(`${row.product_id}:${row.id}`);
              const delta = a?.suggested_price ? a.suggested_price - row.price : null;
              const deltaPct = delta ? (delta / row.price) * 100 : null;

              let statusBadge: React.ReactNode;
              if (isAnalyzing) {
                statusBadge = <span className="px-2 py-1 text-xs rounded bg-yellow-900/50 text-yellow-400 animate-pulse-dot">Analyzing...</span>;
              } else if (a?.error) {
                statusBadge = <span className="px-2 py-1 text-xs rounded bg-red-900/50 text-red-400">Failed</span>;
              } else if (a?.applied) {
                statusBadge = <span className="px-2 py-1 text-xs rounded bg-green-900/50 text-green-400">Applied</span>;
              } else if (a?.suggested_price) {
                statusBadge = <span className="px-2 py-1 text-xs rounded bg-blue-900/50 text-blue-400">Review</span>;
              } else {
                statusBadge = <span className="px-2 py-1 text-xs rounded bg-gray-700 text-gray-400">&mdash;</span>;
              }

              const imageUrl = row.product.image_url?.replace(/\.([^.]+)$/, '_100x100.$1');

              return (
                <tr key={row.id} className={`border-b border-gray-700 hover:bg-gray-800/50 transition-colors ${selected.has(row.id) ? 'bg-blue-900/20' : ''} ${isAnalyzing ? 'animate-analyzing' : ''}`}>
                  <td className="px-4 py-3">
                    <input type="checkbox" checked={selected.has(row.id)}
                      onChange={e => {
                        const next = new Set(selected);
                        e.target.checked ? next.add(row.id) : next.delete(row.id);
                        setSelected(next);
                      }}
                      className="rounded bg-gray-700 border-gray-600" />
                  </td>
                  <td className="px-2 py-2">
                    {imageUrl ? (
                      <img src={imageUrl} alt="" className="w-12 h-12 object-cover rounded cursor-pointer hover:opacity-80"
                        onClick={() => setModalVariant(row)} loading="lazy" />
                    ) : (
                      <div className="w-12 h-12 bg-gray-700 rounded flex items-center justify-center text-gray-500 text-xs">No img</div>
                    )}
                  </td>
                  <td className="px-4 py-3 cursor-pointer" onClick={() => setModalVariant(row)}>
                    <div className="font-medium">{row.product.title}</div>
                    <div className="text-xs text-gray-500">
                      {row.title && row.title !== 'Default Title' ? row.title + ' · ' : ''}
                      {row.product.vendor || 'No vendor'}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-400 font-mono text-xs">{row.sku || '—'}</td>
                  <td className="px-4 py-3 text-right font-medium">${row.price.toFixed(2)}</td>
                  <td className="px-4 py-3 text-right">{row.cost ? `$${row.cost.toFixed(2)}` : <span className="text-gray-500">—</span>}</td>
                  <td className={`px-4 py-3 text-right ${marginClass}`}>
                    {margin !== null ? margin.toFixed(1) + '%' : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {a?.suggested_price && !a.applied ? (
                      <>
                        <span className="text-blue-400 font-medium">${a.suggested_price.toFixed(2)}</span>
                        {delta !== null && deltaPct !== null && (
                          <span className={`text-xs ml-1 ${delta >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            ({delta >= 0 ? '+' : ''}{deltaPct.toFixed(1)}%)
                          </span>
                        )}
                      </>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-3 text-center">{statusBadge}</td>
                  <td className="px-4 py-3 text-center space-x-1">
                    {a?.suggested_price && !a.applied && !a.error && (
                      <button onClick={() => acceptSuggestion(a.id)}
                        className="px-3 py-1 text-xs bg-green-600 hover:bg-green-700 rounded">Accept</button>
                    )}
                    <button onClick={() => setModalVariant(row)}
                      className="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded">View</button>
                    <button onClick={() => analyzeVariant(row.product_id, row.id)}
                      disabled={isAnalyzing}
                      className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded">
                      {isAnalyzing ? '...' : a ? '↻' : 'Analyze'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {filtered.length === 0 && (
          <div className="p-8 text-center text-gray-500">
            <p className="text-lg mb-2">{rows.length === 0 ? 'No products loaded' : 'No matching products'}</p>
            <p className="text-sm">{rows.length === 0 ? 'Sync from Shopify on the Dashboard' : 'Try adjusting your filters'}</p>
          </div>
        )}
      </div>

      {/* Pagination */}
      <div className="bg-gray-800 border-t border-gray-700 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-400">Show</span>
          <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }}
            className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm">
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={250}>250</option>
          </select>
          <span className="text-sm text-gray-400">per page</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
            className="px-3 py-1 bg-gray-700 rounded text-sm disabled:opacity-50">Previous</button>
          <span className="text-sm text-gray-400">Page {page} of {totalPages || 1}</span>
          <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
            className="px-3 py-1 bg-gray-700 rounded text-sm disabled:opacity-50">Next</button>
        </div>
        <div className="text-sm text-gray-400">{filtered.length} variants</div>
      </div>

      {/* Bulk Action Bar */}
      {selectedCount > 0 && !batchActive && (
        <div className="bg-gray-800 border-t border-blue-500 px-4 py-3 flex items-center justify-between">
          <span className="text-sm font-medium">{selectedCount} variant{selectedCount > 1 ? 's' : ''} selected</span>
          <div className="flex items-center gap-3">
            <button onClick={openBatchConfig}
              className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded text-sm font-medium">
              Batch Analyze Selected
            </button>
            {hasSelectedSuggestions && (
              <button onClick={async () => {
                const selectedWithSuggestions = rows.filter(r =>
                  selected.has(r.id) && r.analysis?.suggested_price && !r.analysis.applied && !r.analysis.error
                );
                let success = 0;
                for (const r of selectedWithSuggestions) {
                  if (r.analysis) {
                    try { await acceptSuggestion(r.analysis.id); success++; } catch { /* continue */ }
                  }
                }
                showToast(`Applied ${success} price updates`, 'success');
              }} className="bg-green-600 hover:bg-green-700 px-4 py-2 rounded text-sm">
                Accept All Suggestions
              </button>
            )}
          </div>
          <button onClick={() => setSelected(new Set())} className="text-sm text-gray-400 hover:text-white">
            Deselect All
          </button>
        </div>
      )}

      {/* Modal */}
      {modalVariant && (
        <ProductModal
          product={modalVariant.product}
          variant={modalVariant}
          analysis={modalVariant.analysis}
          settings={settings}
          onClose={() => setModalVariant(null)}
          onAccept={acceptSuggestion}
          onReanalyze={analyzeVariant}
        />
      )}
    </>
  );
}
