import type { Metadata } from 'next';
import './globals.css';
import Sidebar from '@/components/Sidebar';
import { ToastProvider } from '@/components/Toast';

export const metadata: Metadata = {
  title: 'Oil Slick Pad Pricing Suite',
  description: 'AI-powered dynamic pricing optimization for Shopify',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-900 text-gray-100 min-h-screen">
        <ToastProvider>
          <div className="flex h-screen">
            <Sidebar />
            <main className="flex-1 overflow-hidden flex flex-col">
              {children}
            </main>
          </div>
        </ToastProvider>
      </body>
    </html>
  );
}
