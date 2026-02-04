import { Suspense } from 'react';
import ProductsContent from '@/components/ProductsContent';

export default function ProductsPage() {
  return (
    <Suspense fallback={
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full" />
      </div>
    }>
      <ProductsContent />
    </Suspense>
  );
}
