function readValue() {
  return Math.random() < 0.5 ? 42 : "unchecked";
}

const value = readValue() as number;
void value;
