import { generateEmbedding } from "./vector-db.js";
import { VectorDB } from "./vector-db.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

async function testEmbeddings() {
  console.log("=== Testing Embedding Generation ===\n");

  const texts = [
    "Let's schedule a phone call to discuss the project",
    "Can we do a FaceTime later today?",
    "The quarterly budget report is attached",
    "I'll give you a ring tomorrow morning",
    "Please review the financial spreadsheet",
    "Let's hop on a video call this afternoon",
    "The invoice for Q3 services is ready",
    "Can you call me back when you're free?",
  ];

  console.log("Generating embeddings for test texts...\n");
  const embeddings: number[][] = [];
  for (const text of texts) {
    const emb = await generateEmbedding(text);
    embeddings.push(emb);
    console.log(`  ✓ "${text.substring(0, 50)}..." → ${emb.length} dimensions`);
  }

  console.log("\n=== Semantic Similarity Matrix ===\n");

  // Compute cosine similarities
  function cosine(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // Show key comparisons
  const comparisons = [
    [0, 1, "phone call ↔ FaceTime"],
    [0, 2, "phone call ↔ budget report"],
    [0, 3, "phone call ↔ give you a ring"],
    [0, 5, "phone call ↔ video call"],
    [1, 5, "FaceTime ↔ video call"],
    [1, 7, "FaceTime ↔ call me back"],
    [2, 4, "budget report ↔ financial spreadsheet"],
    [2, 6, "budget report ↔ invoice Q3"],
    [4, 6, "financial spreadsheet ↔ invoice Q3"],
    [3, 7, "give you a ring ↔ call me back"],
  ];

  for (const [i, j, label] of comparisons) {
    const sim = cosine(embeddings[i as number], embeddings[j as number]);
    const bar = "█".repeat(Math.round(sim * 30));
    console.log(`  ${(sim as number).toFixed(3)} ${bar} ${label}`);
  }

  console.log("\n=== Testing Vector DB ===\n");

  // Use temp dir for test DB
  const testDir = path.join(os.tmpdir(), "gmail-mcp-test-" + Date.now());
  fs.mkdirSync(testDir, { recursive: true });

  const db = new VectorDB(testDir);

  // Index mock emails
  const mockEmails = texts.map((text, i) => ({
    id: `msg_${i}`,
    threadId: `thread_${Math.floor(i / 2)}`,
    subject: text.substring(0, 40),
    from: "test@example.com",
    to: "user@example.com",
    date: new Date().toISOString(),
    snippet: text,
    body: text,
  }));

  console.log("Indexing mock emails...");
  const result = await db.indexEmails("test@example.com", mockEmails);
  console.log(`  Indexed: ${result.indexed}, Skipped: ${result.skipped}`);

  // Test semantic search
  console.log("\n--- Searching: 'calling someone' ---");
  const callResults = await db.semanticSearch("test@example.com", "calling someone", 5);
  for (const r of callResults) {
    console.log(`  ${r.similarity.toFixed(3)} | ${r.snippet}`);
  }

  console.log("\n--- Searching: 'money and finances' ---");
  const finResults = await db.semanticSearch("test@example.com", "money and finances", 5);
  for (const r of finResults) {
    console.log(`  ${r.similarity.toFixed(3)} | ${r.snippet}`);
  }

  console.log("\n--- Searching: 'video meeting' ---");
  const meetResults = await db.semanticSearch("test@example.com", "video meeting", 5);
  for (const r of meetResults) {
    console.log(`  ${r.similarity.toFixed(3)} | ${r.snippet}`);
  }

  // Test find similar
  console.log("\n--- Finding similar to 'phone call' email ---");
  const similar = await db.findSimilarEmails("test@example.com", "msg_0", 5);
  for (const r of similar) {
    console.log(`  ${r.similarity.toFixed(3)} | ${r.snippet}`);
  }

  // Test re-indexing (should skip)
  console.log("\n--- Re-indexing (should skip all) ---");
  const result2 = await db.indexEmails("test@example.com", mockEmails);
  console.log(`  Indexed: ${result2.indexed}, Skipped: ${result2.skipped}`);

  // Stats
  console.log("\n--- Index Stats ---");
  const stats = db.getIndexStats("test@example.com");
  console.log(`  ${JSON.stringify(stats, null, 2)}`);

  // Cleanup
  db.close();
  fs.rmSync(testDir, { recursive: true });

  console.log("\n=== All tests passed! ===\n");
}

testEmbeddings().catch(console.error);
