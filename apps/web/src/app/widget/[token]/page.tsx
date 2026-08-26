import { Suspense } from "react";
import { WidgetChat } from "./widget-chat";

/**
 * Public customer-care chat surface loaded inside the embeddable widget
 * iframe (or opened directly by link). No chrome, no navigation.
 */
export default function WidgetPage({ params }: { params: Promise<{ token: string }> }) {
  return (
    <Suspense fallback={null}>
      <WidgetChat params={params} />
    </Suspense>
  );
}
