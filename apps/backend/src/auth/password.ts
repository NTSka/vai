import argon2 from "argon2";

export type PasswordVerifier = {
  verify(input: {
    readonly passwordHash: string;
    readonly password: string;
  }): Promise<boolean>;
  hash(password: string): Promise<string>;
};

export function createArgon2PasswordVerifier(): PasswordVerifier {
  return {
    async verify(input) {
      return argon2.verify(input.passwordHash, input.password);
    },
    async hash(password) {
      return argon2.hash(password, { type: argon2.argon2id });
    }
  };
}
