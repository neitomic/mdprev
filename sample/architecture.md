# Architecture

Some Rust code:

```rust
fn main() {
    println!("hello, {}", "world");
}
```

## Flow (mermaid)

```mermaid
graph TD
    A[Browser] -->|SSE| B(mdprev)
    B --> C{Render}
    C -->|md| D[HTML]
```

## ASCII diagram

```bob
  +------+     +------+
  | box  +---->| box2 |
  +------+     +------+
```

Back to [home](README.md).

