import type { ClaudeAuthResponse } from "@getpaseo/protocol/messages";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

type AuthState = ClaudeAuthResponse["payload"];

export function ClaudeAuthPanel({
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
  const [code, setCode] = useState("");
  const [codeResetKey, setCodeResetKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    let active = true;
    const load = async () => {
      try {
        const next = await client.claudeAuth("status");
        if (active && !actionStartedRef.current) setState(next);
      } catch {
        if (active) setError(t("settings.providers.claudeAuth.checkFailed"));
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [client, t]);

  useEffect(() => {
    if (!client || !["starting", "pending", "checking"].includes(state?.status ?? "")) return;
    let active = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const next = await client.claudeAuth("status");
        if (active) {
          setState(next);
          if (next.status === "connected") onConnected();
        }
      } catch {
        if (active) setError(t("settings.providers.claudeAuth.checkFailed"));
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
    async (action: "start" | "submit" | "cancel") => {
      if (!client || busy) return;
      actionStartedRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const next = await client.claudeAuth(action, action === "submit" ? code : undefined);
        setState(next);
        if (action === "submit") {
          setCode("");
          setCodeResetKey((current) => current + 1);
        }
        if (next.status === "connected") onConnected();
      } catch {
        setError(t("settings.providers.claudeAuth.actionFailed"));
      } finally {
        setBusy(false);
      }
    },
    [busy, client, code, onConnected, t],
  );
  const start = useCallback(() => void run("start"), [run]);
  const submit = useCallback(() => void run("submit"), [run]);
  const cancel = useCallback(() => void run("cancel"), [run]);

  const openLink = useCallback(() => {
    if (state?.status !== "pending") return;
    void Linking.openURL(state.url).catch(() => {
      setError(t("settings.providers.claudeAuth.openFailed"));
    });
  }, [state, t]);

  let content: ReactNode;
  if (state?.status === "connected") {
    content = (
      <Text style={styles.description}>{t("settings.providers.claudeAuth.connected")}</Text>
    );
  } else if (state?.status === "pending") {
    content = (
      <>
        <Text style={styles.description}>{t("settings.providers.claudeAuth.instruction")}</Text>
        <Text selectable style={styles.url} testID="claude-auth-url">
          {state.url}
        </Text>
        <Button variant="secondary" size="sm" onPress={openLink}>
          {t("settings.providers.claudeAuth.open")}
        </Button>
        <AdaptiveTextInput
          initialValue=""
          resetKey={codeResetKey}
          onChangeText={setCode}
          placeholder={t("settings.providers.claudeAuth.codePlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          testID="claude-auth-code"
          style={styles.input}
        />
        <View style={styles.actions}>
          <Button variant="default" size="sm" disabled={busy || !code.trim()} onPress={submit}>
            {busy
              ? t("settings.providers.claudeAuth.checking")
              : t("settings.providers.claudeAuth.submit")}
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onPress={cancel}>
            {t("settings.providers.claudeAuth.cancel")}
          </Button>
        </View>
      </>
    );
  } else if (state?.status === "starting" || state?.status === "checking") {
    content = (
      <>
        <Text style={styles.description}>{t("settings.providers.claudeAuth.checking")}</Text>
        <Button variant="secondary" size="sm" disabled={busy} onPress={cancel}>
          {t("settings.providers.claudeAuth.cancel")}
        </Button>
      </>
    );
  } else {
    content = (
      <>
        <Text style={styles.description}>{t("settings.providers.claudeAuth.description")}</Text>
        <Button variant="default" size="sm" disabled={busy || !client} onPress={start}>
          {busy
            ? t("settings.providers.claudeAuth.starting")
            : t("settings.providers.claudeAuth.connect")}
        </Button>
      </>
    );
  }

  return (
    <View style={styles.card} testID="claude-auth-panel">
      <Text style={styles.title}>{t("settings.providers.claudeAuth.title")}</Text>
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
  url: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  actions: { flexDirection: "row", gap: theme.spacing[2] },
  input: {
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[3],
    fontSize: theme.fontSize.base,
  },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
