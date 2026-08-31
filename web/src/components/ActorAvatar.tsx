import type { ActorIdentity } from "../types";

export function ActorAvatar({
  actor,
  className = "",
}: {
  actor: ActorIdentity;
  className?: string;
}) {
  const isCodexAgent = actor.type === "agent" && actor.id === "codex-agent";
  const showsImage = isCodexAgent || Boolean(actor.avatarUrl);
  return (
    <span
      className={`actor-avatar actor-avatar-${actor.type}${
        showsImage ? "" : " actor-avatar-initial"
      }${className ? ` ${className}` : ""}`}
      aria-hidden="true"
      title={actor.name}
    >
      {isCodexAgent ? (
        <img
          className="actor-avatar-image actor-avatar-agent-image"
          src="codex-agent-logo.png"
          alt=""
        />
      ) : actor.avatarUrl ? (
        <img
          className="actor-avatar-image"
          src={actor.avatarUrl}
          alt=""
          referrerPolicy="no-referrer"
        />
      ) : actor.name.slice(0, 1)}
    </span>
  );
}
