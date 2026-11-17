import { ChalkTalkApp } from "@/components/app/ChalkTalkApp";
import { SAMPLES } from "@/lib/lesson/samples.generated";

export default function Home() {
  return <ChalkTalkApp samples={SAMPLES} />;
}
