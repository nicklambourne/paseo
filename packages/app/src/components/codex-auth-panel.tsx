import type { CodexAuthResponse } from "@getpaseo/protocol/messages";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

type AuthState = CodexAuthResponse["payload"];

export function CodexAuthPanel({
  serverId,
  onConnected,
}: {
  serverId: string;
  onConnected: () => void;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const [state, setState] = useState<AuthState | null>(null);
  const actionStartedRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    let active = true;
    const load = async () => {
      try {
        const next = await client.codexAuth("status");
        if (active && !actionStartedRef.current) setState(next);
      } catch {
        if (active) setError(t("settings.providers.codexAuth.checkFailed"));
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [client, t]);

  useEffect(() => {
    if (!client || !["starting", "pending"].includes(state?.status ?? "")) return;
    let active = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const next = await client.codexAuth("status");
        if (active) {
          setState(next);
          if (next.status === "connected") onConnected();
        }
      } catch {
        if (active) setError(t("settings.providers.codexAuth.checkFailed"));
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => void poll(), 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client, onConnected, state?.status, t]);

  const run = useCallback(
    async (action: "start" | "cancel") => {
      if (!client || busy) return;
      actionStartedRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const next = await client.codexAuth(action);
        setState(next);
        if (next.status === "connected") onConnected();
      } catch {
        setError(t("settings.providers.codexAuth.actionFailed"));
      } finally {
        setBusy(false);
      }
    },
    [busy, client, onConnected, t],
  );
  const start = useCallback(() => void run("start"), [run]);
  const cancel = useCallback(() => void run("cancel"), [run]);

  const openLink = useCallback(() => {
    if (state?.status !== "pending") return;
    void Linking.openURL(state.url).catch(() => {
      setError(t("settings.providers.codexAuth.openFailed"));
    });
  }, [state, t]);

  let content: ReactNode;
  if (state?.status === "connected") {
    content = <Text style={styles.description}>{t("settings.providers.codexAuth.connected")}</Text>;
  } else if (state?.status === "pending") {
    content = (
      <>
        <Text style={styles.description}>{t("settings.providers.codexAuth.instruction")}</Text>
        <Text selectable style={styles.value} testID="codex-auth-url">
          {state.url}
        </Text>
        <Text selectable style={styles.code} testID="codex-auth-code">
          {state.code}
        </Text>
        <View style={styles.actions}>
          <Button variant="default" size="sm" onPress={openLink}>
            {t("settings.providers.codexAuth.open")}
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onPress={cancel}>
            {t("settings.providers.codexAuth.cancel")}
          </Button>
        </View>
      </>
    );
  } else if (state?.status === "starting") {
    content = (
      <>
        <Text style={styles.description}>{t("settings.providers.codexAuth.starting")}</Text>
        <Button variant="secondary" size="sm" disabled={busy} onPress={cancel}>
          {t("settings.providers.codexAuth.cancel")}
        </Button>
      </>
    );
  } else {
    content = (
      <>
        <Text style={styles.description}>{t("settings.providers.codexAuth.description")}</Text>
        <Button variant="default" size="sm" disabled={busy || !client} onPress={start}>
          {busy
            ? t("settings.providers.codexAuth.starting")
            : t("settings.providers.codexAuth.connect")}
        </Button>
      </>
    );
  }

  return (
    <View style={styles.card} testID="codex-auth-panel">
      <Text style={styles.title}>{t("settings.providers.codexAuth.title")}</Text>
      {content}
      {state?.status === "error" ? <Text style={styles.error}>{state.message}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    margin: theme.spacing[4],
    padding: theme.spacing[4],
    gap: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  description: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  value: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  code: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
  },
  actions: { flexDirection: "row", gap: theme.spacing[2] },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
