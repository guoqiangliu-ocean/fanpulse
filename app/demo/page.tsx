import type { Metadata } from "next";
import Link from "next/link";
import styles from "./demo.module.css";

export const metadata: Metadata = {
  title: "FanPulse demo — TxLINE World Cup fan experience",
  description:
    "A 4 minute 42 second walkthrough of FanPulse, a no-stakes World Cup second-screen companion powered by authenticated TxLINE snapshots.",
};

export default function DemoPage() {
  return (
    <main className={styles.page}>
      <nav className={styles.nav} aria-label="FanPulse demo navigation">
        <Link href="/" className={styles.brand}>
          <span aria-hidden="true">FP</span>
          FanPulse
        </Link>
        <Link href="/" className={styles.back}>
          Open the live product
        </Link>
      </nav>

      <section className={styles.hero}>
        <p className={styles.eyebrow}>WORLD CUP FAN EXPERIENCE · 4:42</p>
        <h1>The complete FanPulse demo.</h1>
        <p className={styles.lead}>
          See the authenticated fixture flow, the private no-stakes pulse pick,
          the guarded reveal, the clearly labelled synthetic replay, and the
          publisher path in one concise walkthrough.
        </p>

        <div className={styles.playerShell}>
          <video
            className={styles.player}
            controls
            preload="metadata"
            poster="/fanpulse-og.png"
          >
            <source src="/fanpulse-demo.mp4" type="video/mp4" />
            Your browser does not support embedded MP4 video.
          </video>
        </div>

        <div className={styles.notes}>
          <p>
            Authenticated TxLINE snapshots, not a continuous live stream. No
            wallet, wagering, prediction guarantee, or profit claim.
          </p>
          <a
            href="https://github.com/guoqiangliu-ocean/fanpulse"
            target="_blank"
            rel="noreferrer"
          >
            Review the public source and evidence rules
          </a>
        </div>
      </section>
    </main>
  );
}
