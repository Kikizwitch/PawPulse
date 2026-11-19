// 讀環境變數：先讀 .env.local（本機開發），再讀 .env；同一個 key 以先讀到嘅為準
// ES module 會先執行晒所有 import 先至行本檔內文，所以任何喺頂層讀 process.env 嘅模組
// 都要先 import 呢個檔，唔可以靠 server.ts 內文 call dotenv
import dotenv from "dotenv";

dotenv.config({ path: [".env.local", ".env"], quiet: true });
