/** A rule violation the player can be told about, such as an invalid bet. */
export class GameError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GameError";
  }
}
