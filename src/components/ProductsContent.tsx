'use client';

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useToast } from '@/components/Toast';
import ProductModal from '@/components/ProductModal';
import type { Product, Variant, Analysis } from '@/types';

interface VariantRow extends Variant {
  product: Product;
  analysis: Analysis | null;
}

export default function ProductsContent() {
  const { showToast } = useToast();
  const searchParams = useSearchParams();

  const [rows, setRows] = useState<VariantRow[]>([]);
  const [filtered, setFiltered] = useState<VariantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') || '');
  const [vendorFilter, setVendorFilter] = useState('');
  const [sortBy, setSortBy] = useState('name-asc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [analyzing, setAnalyzing] = useState<Set<string>>(new Set());
  const [modalVariant, setModalVariant] = useState<VariantRow | null>(null);

  const vendors = [...new Set(rows.map(r => r.product.vendor).filter(Boolean))] as string[];

  // Load all products + variants + analyses
  const loadData = useCallback(async () => {
    try {
      const { data: products } = await supabase
        .from('products')
        .select('*')
        .order('title');

      const { data: variants } = await supabase
        .from('variants')
        .select('*');

      const { data: analyses } = await supabase
        .from('analyses')
        .select('*');

      if (!products || !variants) return;

      const productMap = new Map(products.map(p => [p.id, p as Product]));
      const analysisMap = new Map((analyses || []).map(a => [a.variant_id, a as Analysis]));

      const variantRows: VariantRow[] = variants.map(v => ({
        ...(v as Variant),
        product: productMap.get(v.product_id) as Product,
        analysis: analysisMap.get(v.id) || null,
      })).filter(v => v.product); // filter out orphans

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
          case 'below_floor': return margin !== null && margin >= 0 && margin < 20;
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
  }, [rows, search, statusFilter, vendorFilter, sortBy]);

  const totalPages = Math.ceil(filtered.length / pageSize);
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);

  // Analyze a single variant
  async function analyzeVariant(productId: string, variantId: string) {
    const key = `${productId}:${variantId}`;
    setAnalyzing(prev => new Set(prev).add(key));

    try {
      const res = await fetch('/api/analysis/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, variantId }),
      });
      const data = await res.json();
      if (data.success) {
        showToast('Analysis complete', 'success');
        loadData(); // Reload to get updated analysis
      } else {
        showToast(`Analysis failed: ${data.error}`, 'error');
      }
    } catch {
      showToast('Analysis failed: network error', 'error');
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

  // Bulk analyze selected
  async function analyzeSelected() {
    const selectedRows = rows.filter(r => selected.has(r.id));
    showToast(`Analyzing ${selectedRows.length} variants...`, 'info');
    for (const r of selectedRows) {
      await analyzeVariant(r.product_id, r.id);
    }
    showToast('Bulk analysis complete', 'success');
  }

  // Bulk accept all selected with suggestions
  async function acceptAllSelected() {
    const selectedWithSuggestions = rows.filter(r =>
      selected.has(r.id) && r.analysis?.suggested_price && !r.analysis.applied && !r.analysis.error
    );
    let success = 0;
    for (const r of selectedWithSuggestions) {
      if (r.analysis) {
        try {
          await acceptSuggestion(r.analysis.id);
          success++;
        } catch { /* continue */ }
      }
    }
    showToast(`Applied ${success} price updates`, 'success');
  }

  // Analyze all visible
  async function analyzeAllVisible() {
    showToast(`Analyzing ${filtered.length} variants...`, 'info');
    // Process in batches of 5 to avoid overwhelming the server
    for (let i = 0; i < filtered.length; i += 5) {
      const batch = filtered.slice(i, i + 5);
      await Promise.all(batch.map(r => analyzeVariant(r.product_id, r.id)));
    }
    showToast('Bulk analysis complete', 'success');
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

  return (
    <>
      {/* Filter Bar */}
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
        <button onClick={analyzeAllVisible}
          className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded text-sm flex items-center gap-2">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
          </svg>
          Analyze All Visible
        </button>
        <button onClick={exportCSV}
          className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded text-sm">
          Export CSV
        </button>
      </div>

      {/* Product Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-800 sticky top-0">
            <tr className="border-b border-gray-700">
              <th className="w-10 px-4 py-3 text-left">
                <input type="checkbox"
                  checked={selected.size === filtered.length && filtered.length > 0}
                  onChange={e => {
                    if (e.target.checked) setSelected(new Set(filtered.map(r => r.id)));
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
                <tr key={row.id} className={`border-b border-gray-700 hover:bg-gray-800/50 ${selected.has(row.id) ? 'bg-blue-900/20' : ''}`}>
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
      {selectedCount > 0 && (
        <div className="bg-gray-800 border-t border-blue-500 px-4 py-3 flex items-center justify-between">
          <span className="text-sm font-medium">{selectedCount} variant{selectedCount > 1 ? 's' : ''} selected</span>
          <div className="flex items-center gap-3">
            <button onClick={analyzeSelected} className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded text-sm">
              Analyze Selected
            </button>
            {hasSelectedSuggestions && (
              <button onClick={acceptAllSelected} className="bg-green-600 hover:bg-green-700 px-4 py-2 rounded text-sm">
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
          onClose={() => setModalVariant(null)}
          onAccept={acceptSuggestion}
          onReanalyze={analyzeVariant}
        />
      )}
    </>
  );
}
