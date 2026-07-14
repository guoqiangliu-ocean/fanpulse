import type { Metadata } from "next";
import { FanPulse } from "./fanpulse";

export const metadata: Metadata = {
  title: "FanPulse — The match story behind the market",
  description:
    "A phone-first World Cup companion that turns authenticated TxLINE score and odds snapshots into a clear, no-stakes fan experience.",
  openGraph: {
    type: "website",
    title: "FanPulse — The match story behind the market",
    description:
      "Pick a side, reveal the current market pulse, and see exactly how strong the evidence is.",
    images: [
      {
        url: "/fanpulse-og.png",
        width: 1672,
        height: 941,
        alt: "FanPulse World Cup second-screen companion",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "FanPulse — The match story behind the market",
    description:
      "A no-stakes World Cup pulse pick powered by authenticated TxLINE snapshots.",
    images: ["/fanpulse-og.png"],
  },
};

export default function Home() {
  return <FanPulse />;
}
