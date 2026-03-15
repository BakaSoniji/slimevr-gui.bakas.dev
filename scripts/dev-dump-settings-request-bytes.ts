/**
 * Dumps the FlatBuffers binary template for an empty-table RPC request
 * wrapped in a MessageBundle, and verifies the union type byte offset.
 *
 * Usage: bun scripts/dev-dump-settings-request-bytes.ts --server-repo <path to SlimeVR-Server>
 *
 * Requires: solarxr-protocol built in the SlimeVR-Server repo
 */

import { parseArgs } from "util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "server-repo": { type: "string" },
  },
  strict: true,
});

if (!values["server-repo"]) {
  console.error(
    "Usage: bun scripts/dev-dump-settings-request-bytes.ts --server-repo <path to SlimeVR-Server>",
  );
  process.exit(1);
}

const serverRepo = values["server-repo"];

const { Builder } = await import(`${serverRepo}/gui/node_modules/flatbuffers`);
const protocol = await import(
  `${serverRepo}/solarxr-protocol/protocol/typescript/dist/all_generated.js`
);

const { MessageBundleT, RpcMessageHeaderT, RpcMessage, SettingsRequestT } =
  protocol;

// Build a SettingsRequest (union type 6) to use as the template
const fbb = new Builder(1);
const message = new MessageBundleT();
const rpcHeader = new RpcMessageHeaderT();
rpcHeader.messageType = RpcMessage.SettingsRequest; // = 6
rpcHeader.message = new SettingsRequestT();
message.rpcMsgs = [rpcHeader];
fbb.finish(message.pack(fbb));

const bytes = fbb.asUint8Array();

// Find the union type byte offset by looking for the SettingsRequest type (6)
// and verifying it's at the expected position
const EXPECTED_TYPE = RpcMessage.SettingsRequest; // 6
const typeOffsets: number[] = [];
for (let i = 0; i < bytes.length; i++) {
  if (bytes[i] === EXPECTED_TYPE) typeOffsets.push(i);
}

// Create a zeroed template (union type = 0 / NONE)
const template = new Uint8Array(bytes);
const unionTypeOffset = 67; // known offset from FlatBuffers layout analysis
template[unionTypeOffset] = 0;

// Verify by rebuilding with a different union type and checking the offset
const fbb2 = new Builder(1);
const message2 = new MessageBundleT();
const rpcHeader2 = new RpcMessageHeaderT();
rpcHeader2.messageType = RpcMessage.HeartbeatRequest; // = 1
rpcHeader2.message = new protocol.HeartbeatRequestT();
message2.rpcMsgs = [rpcHeader2];
fbb2.finish(message2.pack(fbb2));
const bytes2 = fbb2.asUint8Array();

if (bytes2[unionTypeOffset] !== RpcMessage.HeartbeatRequest) {
  console.error(
    `ERROR: Union type offset ${unionTypeOffset} does not hold the expected value.` +
      ` Got ${bytes2[unionTypeOffset]}, expected ${RpcMessage.HeartbeatRequest}.`,
  );
  process.exit(1);
}

// Verify templates are identical except for the union type byte
let diffs = 0;
for (let i = 0; i < bytes.length; i++) {
  if (bytes[i] !== bytes2[i]) diffs++;
}
if (diffs !== 1) {
  console.error(
    `ERROR: Expected exactly 1 byte difference between SettingsRequest and HeartbeatRequest templates, got ${diffs}.`,
  );
  process.exit(1);
}

console.log(`Template size: ${template.length} bytes`);
console.log(`Union type offset: ${unionTypeOffset}`);
console.log(
  `Verified: patching byte ${unionTypeOffset} changes the RPC union type.`,
);
console.log();

// Output the zeroed template
console.log(
  `const RPC_TEMPLATE = new Uint8Array([${Array.from(template).join(", ")}]);`,
);
console.log(`const UNION_TYPE_OFFSET = ${unionTypeOffset};`);
