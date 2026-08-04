export type OwnerEpochLease<Owner extends object = object> = Readonly<{
  owner: Owner;
  epoch: number;
}>;

export type OwnerEpochActivation = Readonly<{
  id: number;
}>;

export type OwnerEpochCommit<Owner extends object> = Readonly<{
  changed: boolean;
  lease: OwnerEpochLease<Owner> | null;
}>;

export type OwnerEpochLeaseController<Owner extends object> = Readonly<{
  commit(owner: Owner): OwnerEpochCommit<Owner>;
  activate(): OwnerEpochActivation;
  deactivate(activation: OwnerEpochActivation): boolean;
  capture(owner: Owner): OwnerEpochLease<Owner> | null;
  isCurrent(lease: OwnerEpochLease<Owner>): boolean;
}>;

export function createOwnerEpochLeaseController<Owner extends object>():
  OwnerEpochLeaseController<Owner> {
  let committedOwner: Owner | null = null;
  let epoch = 0;
  let nextActivationId = 1;
  let activation: OwnerEpochActivation | null = null;
  let activeLease: OwnerEpochLease<Owner> | null = null;

  const issueLease = (): OwnerEpochLease<Owner> | null => {
    if (!activation || !committedOwner) return null;
    return Object.freeze({ owner: committedOwner, epoch });
  };

  return {
    commit(owner) {
      if (committedOwner === owner) {
        return { changed: false, lease: activeLease };
      }
      committedOwner = owner;
      epoch += 1;
      activeLease = issueLease();
      return { changed: true, lease: activeLease };
    },

    activate() {
      const nextActivation = Object.freeze({ id: nextActivationId++ });
      activation = nextActivation;
      activeLease = issueLease();
      return nextActivation;
    },

    deactivate(expectedActivation) {
      if (activation !== expectedActivation) return false;
      activation = null;
      activeLease = null;
      return true;
    },

    capture(owner) {
      if (!activeLease || activeLease.owner !== owner) return null;
      return activeLease;
    },

    isCurrent(lease) {
      return activeLease === lease;
    },
  };
}
