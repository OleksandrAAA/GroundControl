import "./openapi/api";
import "reflect-metadata";
import { createConnection, getRepository, Repository } from "typeorm";
import { TokenToAddress } from "./entity/TokenToAddress";
import { SendQueue } from "./entity/SendQueue";
import { KeyValue } from "./entity/KeyValue";
import { TokenToTxid } from "./entity/TokenToTxid";
require("dotenv").config();
const url = require("url");
const parsed = url.parse(process.env.JAWSDB_MARIA_URL);
if (!process.env.JAWSDB_MARIA_URL || !process.env.BITCOIN_RPC) {
  console.error("not all env variables set");
  process.exit();
}

process
  .on("unhandledRejection", (reason, p) => {
    console.error(reason, "Unhandled Rejection at Promise", p);
    process.exit(1);
  })
  .on("uncaughtException", (err) => {
    console.error(err, "Uncaught Exception thrown");
    process.exit(1);
  });

let jayson = require("jayson/promise");
let rpc = url.parse(process.env.BITCOIN_RPC);
let client = jayson.client.http(rpc);

const LAST_PROCESSED_BLOCK = "LAST_PROCESSED_BLOCK";

async function processBlock(blockNum, sendQueueRepository: Repository<SendQueue>) {
  console.log("processing new block", +blockNum);
  const responseGetblockhash = await client.request("getblockhash", [blockNum]);
  const responseGetblock = await client.request("getblock", [responseGetblockhash.result, true]);
  const addresses: string[] = [];
  const allPotentialPushPayloadsArray: Components.Schemas.PushNotificationOnchainAddressGotPaid[] = [];
  const txids: string[] = [];
  for (const tx of responseGetblock.result.tx) {
    txids.push(tx.txid);
    if (tx.vout) {
      for (const output of tx.vout) {
        if (output.scriptPubKey && output.scriptPubKey.addresses) {
          for (const address of output.scriptPubKey.addresses) {
            addresses.push(address);
            const payload: Components.Schemas.PushNotificationOnchainAddressGotPaid = {
              address,
              txid: tx.txid,
              sat: Math.floor(output.value * 100000000),
              type: 2,
              level: "transactions",
              token: "",
              os: "android",
            };
            allPotentialPushPayloadsArray.push(payload);
          }
        }
      }
    }
  }

  process.env.VERBOSE && console.log(addresses.length, "addresses paid in block");
  process.env.VERBOSE && console.log(txids.length, " txids");
  
  // allPotentialPushPayloadsArray.push({ address: "bc1qaemfnglf928kd9ma2jzdypk333au6ctu7h7led", txid: "666", sat: 1488, type: 2, token: "", os: "ios" }); // debug fixme
  // addresses.push("bc1qaemfnglf928kd9ma2jzdypk333au6ctu7h7led"); // debug fixme

  const query = getRepository(TokenToAddress).createQueryBuilder().where("address IN (:...address)", { address: addresses });

  if (addresses.length > 0) {
    for (const t2a of await query.getMany()) {
      // found all addresses that we are tracking on behalf of our users. now,
      // iterating all addresses in a block to see if there is a match.
      // we could only iterate tracked addresses, but that would imply deduplication which is not good (for example,
      // in a single block user could get several incoming payments to different owned addresses)
      // cycle in cycle is less than optimal, but we can live with that for now
      for (let payload of allPotentialPushPayloadsArray) {
        if (t2a.address === payload.address) {
          process.env.VERBOSE && console.log("enqueueing", payload);
          payload.os = t2a.os === "android" ? "android" : "ios"; // hacky
          payload.token = t2a.token;
          payload.type = 2;
          payload.badge = 1;
          await sendQueueRepository.save({
            data: JSON.stringify(payload),
          });
        }
      }
    }
  }

  // now, checking if there is a subscription to one of the mined txids:
  if (txids.length > 0) {
    const query2 = getRepository(TokenToTxid).createQueryBuilder().where("txid IN (:...txids)", { txids });
    for (const t2txid of await query2.getMany()) {
      const payload: Components.Schemas.PushNotificationTxidGotConfirmed = {
        txid: t2txid.txid,
        type: 4,
        level: "transactions",
        token: t2txid.token,
        os: t2txid.os === "ios" ? "ios" : "android",
        badge: 1,
      };

      process.env.VERBOSE && console.log("enqueueing", payload);
      await sendQueueRepository.save({
        data: JSON.stringify(payload),
      });
    }
  }
}

createConnection({
  type: "mariadb",
  host: parsed.hostname,
  port: parsed.port,
  username: parsed.auth.split(":")[0],
  password: parsed.auth.split(":")[1],
  database: parsed.path.replace("/", ""),
  synchronize: true,
  logging: false,
  entities: ["src/entity/**/*.ts"],
  migrations: ["src/migration/**/*.ts"],
  subscribers: ["src/subscriber/**/*.ts"],
  cli: {
    entitiesDir: "src/entity",
    migrationsDir: "src/migration",
    subscribersDir: "src/subscriber",
  },
})
  .then(async (connection) => {
    // start worker
    console.log("running groundcontrol worker-blockprocessor");
    console.log(require("fs").readFileSync("./bowie.txt").toString("ascii"));

    const KeyValueRepository = getRepository(KeyValue);
    const sendQueueRepository = getRepository(SendQueue);

    while (1) {
      const keyVal = await KeyValueRepository.findOne({ key: LAST_PROCESSED_BLOCK });
      process.env.VERBOSE && console.log("keyval = ", keyVal);
      if (!keyVal) {
        // if no info saved in database we assume we are all caught up and wait for the next block
        const responseGetblockcount = await client.request("getblockcount", []);
        await KeyValueRepository.save({ key: LAST_PROCESSED_BLOCK, value: responseGetblockcount.result });
        continue; // skipping worker iteration
      }

      const responseGetblockcount = await client.request("getblockcount", []);
      process.env.VERBOSE && console.log("responseGetblockcount = ", responseGetblockcount);

      if (+responseGetblockcount.result <= +keyVal.value) {
        await new Promise((resolve) => setTimeout(resolve, 60000, false));
        continue;
      }

      const nextBlockToProcess = +keyVal.value + 1; // or +responseGetblockcount.result to aways process last block and skip intermediate blocks
      const start = +new Date();
      try {
        await processBlock(nextBlockToProcess, sendQueueRepository);
      } catch (error) {
        console.warn("exception when processing block:", error, "continuing as usuall");
      }
      const end = +new Date();
      console.log("took", (end - start) / 1000, "sec");
      keyVal.value = String(nextBlockToProcess);
      await KeyValueRepository.save(keyVal);
    }
  })
  .catch((error) => {
    console.error("exception in blockprocessor:", error, "comitting suicide");
    process.exit(1);
  });
