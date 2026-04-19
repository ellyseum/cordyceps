/**
 * Agent name generator — Docker-style adjective-noun combos.
 * Used when spawning agents without an explicit `id`.
 */

const ADJECTIVES = [
  "brave", "calm", "clever", "cosmic", "crispy", "dapper", "dizzy", "dreamy",
  "eager", "fancy", "feral", "fierce", "fluffy", "frosty", "funky", "gentle",
  "giddy", "glossy", "goofy", "grand", "grumpy", "happy", "hasty", "hazy",
  "hefty", "humble", "hungry", "icy", "jazzy", "jolly", "keen", "lazy",
  "lively", "lucky", "mellow", "mighty", "misty", "moody", "nimble", "noble",
  "peppy", "plucky", "proud", "quiet", "rapid", "regal", "rowdy", "rusty",
  "salty", "sassy", "shiny", "silly", "sleepy", "slick", "snappy", "sneaky",
  "spicy", "steady", "stormy", "sunny", "swift", "tender", "tiny", "tough",
  "tricky", "vivid", "wacky", "warm", "wild", "witty", "zappy", "zen",
];

const NOUNS = [
  "badger", "beetle", "bobcat", "bunny", "capybara", "chameleon", "cheetah",
  "cobra", "condor", "corgi", "coyote", "crane", "crow", "dingo", "dolphin",
  "donkey", "eagle", "falcon", "ferret", "finch", "firefly", "flamingo",
  "fox", "frog", "gecko", "goose", "gopher", "hawk", "hedgehog", "heron",
  "hornet", "hound", "ibis", "iguana", "impala", "jackal", "jaguar", "jay",
  "koala", "lemur", "leopard", "lobster", "lynx", "macaw", "mantis", "marmot",
  "moose", "narwhal", "newt", "ocelot", "octopus", "orca", "osprey", "otter",
  "owl", "panther", "parrot", "pelican", "penguin", "pika", "puma", "quail",
  "raven", "salmon", "scorpion", "seal", "shark", "sloth", "sparrow", "squid",
  "starling", "stork", "sturgeon", "swan", "tapir", "toucan", "turtle", "viper",
  "walrus", "weasel", "wolf", "wombat", "wren", "yak", "zebra",
];

/** Generate a random adjective-noun name (e.g. "goofy-sturgeon"). */
export function generateName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${noun}`;
}

/** Validate a user-provided name (alphanumeric + hyphens + underscores; max 31 chars). */
export function isValidName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,30}$/.test(name);
}
