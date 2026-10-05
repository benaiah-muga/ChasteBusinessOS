import { WidgetChat } from "./widget-chat";

/**
 * Public customer-care chat surface loaded inside the embeddable widget
 * iframe (or opened directly by link). No chrome, no navigation.
 */
export default async function WidgetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <WidgetChat token={token} />;
}
