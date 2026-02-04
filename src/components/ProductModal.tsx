'use client';

import type { Product, Variant, Analysis, ProductIdentity, CompetitorAnalysis } from '@/types';

interface Props {
  product: Product;
  variant: Variant;
  analysis: Analysis | null;
  onClose: () => void;
  onAccept: (analysisId: string) => void;
  onReanalyze: (productId: string, variantId: string) => void;
}

export default function ProductModal({ product, variant, analysis, onClose, onAccept, onReanalyze }: Props) {
  const marginPct = variant.cost ? ((variant.price - variant.cost) / variant.price) * 100 : null;
  const suggestedMargin = analysis?.suggested_price && variant.cost
    ? ((analysis.suggested_price - variant.cost) / analysis.suggested_price) * 100 : null;
  const delta = analysis?.suggested_price ? analysis.suggested_price - variant.price : null;
  const deltaPct = delta && variant.price ? (delta / variant.price) * 100 : null;

  const identity = analysis?.product_identity as ProductIdentity | null;
  const compAnalysis = analysis?.competitor_analysis as CompetitorAnalysis | null;

  const tierColors: Record<string, string> = {
    import: 'bg-orange-900/50 text-orange-400 border-orange-700',
    domestic: 'bg-blue-900/50 text-blue-400 border-blue-700',
    heady: 'bg-purple-900/50 text-purple-400 border-purple-700',
  };
  const tierLabels: Record<string, string> = {
    import: 'Import (Overseas)',
    domestic: 'Domestic (USA-Made)',
    heady: 'Heady (Handmade Art)',
  };

  const tier = identity?.originTier || 'unknown';

  return (
    <div className="fixed inset-0 bg-black/50 z-50 overflow-auto" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="min-h-screen flex items-start justify-center p-4 pt-20">
        <div className="bg-gray-800 border border-gray-700 rounded-lg w-full max-w-4xl">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
            <h3 className="text-lg font-medium">{product.title}</h3>
            <button onClick={onClose} className="text-gray-400 hover:text-white">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="p-6">
            {/* Product Info */}
            <div className="flex gap-6 mb-6">
              <div className="flex-shrink-0">
                {product.image_url ? (
                  <img src={product.image_url.replace(/\.([^.]+)$/, '_400x400.$1')} alt=""
                    className="w-32 h-32 object-cover rounded-lg border border-gray-700" />
                ) : (
                  <div className="w-32 h-32 bg-gray-700 rounded-lg flex items-center justify-center text-gray-500">No image</div>
                )}
              </div>
              <div className="flex-1 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <div><span className="text-gray-500">Vendor:</span> <span className="ml-2">{product.vendor || 'Unknown'}</span></div>
                <div><span className="text-gray-500">Type:</span> <span className="ml-2">{product.product_type || 'Unknown'}</span></div>
                <div><span className="text-gray-500">Variant:</span> <span className="ml-2">{variant.title || 'Default'}</span></div>
                <div><span className="text-gray-500">SKU:</span> <span className="ml-2 font-mono text-xs">{variant.sku || 'None'}</span></div>
                {product.tags && (
                  <div className="col-span-2"><span className="text-gray-500">Tags:</span> <span className="ml-2 text-xs">{product.tags}</span></div>
                )}
              </div>
            </div>

            {/* AI Identity */}
            {identity && (
              <div className="bg-blue-900/20 border border-blue-800 rounded-lg p-4 mb-6">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-medium text-blue-400">AI Product Analysis</h4>
                  <span className={`px-3 py-1 text-xs font-medium rounded border ${tierColors[tier] || 'bg-gray-700 text-gray-400 border-gray-600'}`}>
                    {tierLabels[tier] || 'Unknown'}
                  </span>
                </div>
                {identity.productSummary && (
                  <div className="bg-gray-800/50 rounded-lg p-3 mb-4">
                    <p className="text-sm text-gray-200 leading-relaxed">{identity.productSummary}</p>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div><span className="text-gray-500">Identified as:</span> <span className="ml-2 text-white">{identity.identifiedAs || 'Unknown'}</span></div>
                  <div><span className="text-gray-500">Confidence:</span> <span className={`ml-2 ${
                    identity.confidence === 'high' ? 'text-green-400' : identity.confidence === 'medium' ? 'text-yellow-400' : 'text-gray-400'
                  }`}>{identity.confidence || 'Unknown'}</span></div>
                </div>
                {identity.keyFeatures && identity.keyFeatures.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1">
                    {identity.keyFeatures.map((f, i) => (
                      <span key={i} className="px-2 py-0.5 bg-gray-700 rounded text-xs">{f}</span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Analysis Result */}
            {analysis && analysis.suggested_price && !analysis.error ? (
              <div className="grid grid-cols-2 gap-6 mb-6">
                <div className="bg-gray-700/50 rounded-lg p-4">
                  <h4 className="text-sm font-medium text-gray-400 mb-3">AI Recommendation</h4>
                  <div className="text-3xl font-semibold text-blue-400">${analysis.suggested_price.toFixed(2)}</div>
                  {delta !== null && deltaPct !== null && (
                    <div className={`text-sm ${delta >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {delta >= 0 ? '+' : ''}${delta.toFixed(2)} ({delta >= 0 ? '+' : ''}{deltaPct.toFixed(1)}%)
                    </div>
                  )}
                  <div className="text-xs text-gray-500 mt-1">
                    Confidence: <span className={
                      analysis.confidence === 'high' ? 'text-green-400' : analysis.confidence === 'medium' ? 'text-yellow-400' : 'text-red-400'
                    }>{analysis.confidence}</span>
                    {analysis.confidence_reason && ` — ${analysis.confidence_reason}`}
                  </div>
                  {analysis.summary && <p className="text-sm text-gray-300 mt-3">{analysis.summary}</p>}

                  <div className="flex gap-2 mt-4">
                    {!analysis.applied && (
                      <button onClick={() => onAccept(analysis.id)} className="px-4 py-2 bg-green-600 hover:bg-green-700 rounded text-sm">
                        Accept
                      </button>
                    )}
                    <button onClick={() => { onClose(); onReanalyze(product.id, variant.id); }}
                      className="px-4 py-2 bg-gray-600 hover:bg-gray-500 rounded text-sm">
                      Re-analyze
                    </button>
                  </div>
                </div>

                <div className="bg-gray-700/50 rounded-lg p-4">
                  <h4 className="text-sm font-medium text-gray-400 mb-3">Competitor Analysis</h4>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm mb-4">
                    <div className="text-gray-500">Retail Low:</div>
                    <div>${compAnalysis?.low?.toFixed(2) || '—'}</div>
                    <div className="text-gray-500">Retail Median:</div>
                    <div className="font-medium">${compAnalysis?.median?.toFixed(2) || '—'}</div>
                    <div className="text-gray-500">Retail High:</div>
                    <div>${compAnalysis?.high?.toFixed(2) || '—'}</div>
                    <div className="text-gray-500">Competitors:</div>
                    <div>{compAnalysis?.retailCount || 0}</div>
                  </div>
                  {analysis.reasoning && (
                    <>
                      <h5 className="text-xs font-medium text-gray-500 mb-2">Reasoning</h5>
                      <ul className="text-sm text-gray-400 space-y-1 max-h-32 overflow-auto">
                        {(analysis.reasoning as string[]).map((r, i) => (
                          <li key={i} className="flex"><span className="mr-2">&#x2022;</span>{r}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              </div>
            ) : analysis?.error ? (
              <div className="bg-red-900/20 border border-red-800 rounded-lg p-4 mb-6">
                <h4 className="text-red-400 font-medium mb-2">Analysis Failed</h4>
                <p className="text-sm text-gray-400">{analysis.error}</p>
                <button onClick={() => { onClose(); onReanalyze(product.id, variant.id); }}
                  className="mt-3 px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm">
                  Retry
                </button>
              </div>
            ) : (
              <div className="bg-gray-700/50 rounded-lg p-6 text-center mb-6">
                <p className="text-gray-400 mb-3">No analysis for this variant</p>
                <button onClick={() => { onClose(); onReanalyze(product.id, variant.id); }}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm">
                  Run Analysis
                </button>
              </div>
            )}

            {/* Profit Comparison */}
            {analysis?.suggested_price && variant.cost && (
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-gray-700/50 rounded p-3 text-center">
                  <div className="text-xs text-gray-500 mb-1">Current</div>
                  <div className="text-lg font-medium">${variant.price.toFixed(2)}</div>
                  <div className="text-sm text-gray-400">Profit: ${(variant.price - variant.cost).toFixed(2)}</div>
                  <div className={`text-sm ${marginPct && marginPct < 0 ? 'text-red-400' : 'text-green-400'}`}>
                    {marginPct?.toFixed(1)}% margin
                  </div>
                </div>
                <div className="bg-blue-900/30 border border-blue-800 rounded p-3 text-center">
                  <div className="text-xs text-blue-400 mb-1">Suggested</div>
                  <div className="text-lg font-medium text-blue-400">${analysis.suggested_price.toFixed(2)}</div>
                  <div className="text-sm text-gray-400">Profit: ${(analysis.suggested_price - variant.cost).toFixed(2)}</div>
                  <div className={`text-sm ${suggestedMargin && suggestedMargin < 0 ? 'text-red-400' : 'text-green-400'}`}>
                    {suggestedMargin?.toFixed(1)}% margin
                  </div>
                </div>
              </div>
            )}

            {/* Competitor Sources */}
            {compAnalysis?.kept && compAnalysis.kept.length > 0 && (
              <details className="mt-6">
                <summary className="text-sm font-medium text-gray-400 cursor-pointer hover:text-white">
                  Competitor Sources ({compAnalysis.kept.length} kept)
                </summary>
                <div className="mt-3 space-y-2">
                  {compAnalysis.kept.map((s, i) => (
                    <div key={i} className="bg-gray-700/30 rounded p-2 border border-gray-700">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-white">{s.source}</span>
                        <span className="text-lg font-bold text-green-400">${s.price?.toFixed(2) || '—'}</span>
                      </div>
                      {s.url && (
                        <a href={s.url} target="_blank" rel="noopener noreferrer"
                          className="text-xs text-blue-400 hover:text-blue-300 underline break-all">
                          {s.url}
                        </a>
                      )}
                      {s.reason && <div className="text-xs text-gray-500 mt-1">{s.reason}</div>}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
