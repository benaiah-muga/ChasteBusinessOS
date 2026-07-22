import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ChasteBusinessOS",
  description: "AI-native Business Operating System",
};

const themeBootstrap = `(function(){try{
  var s=localStorage.getItem('chaste-theme-saved');
  var a=localStorage.getItem('chaste-accent');
  if(s==='light'||s==='dark'){document.documentElement.dataset.theme=s;}
  if(a){document.documentElement.dataset.accent=a;}
  else{document.documentElement.dataset.accent='maroon';}
}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-accent="maroon" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;720;800&display=swap"
        />
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
