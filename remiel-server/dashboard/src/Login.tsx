export function Login() {
  const params = new URLSearchParams(window.location.search);
  const authError = params.get("auth_error");

  const errorMessages: Record<string, string> = {
    access_denied: "Slack 로그인을 취소했습니다.",
    invalid_state: "인증 요청이 만료되었습니다. 다시 시도해주세요.",
    token_exchange_failed: "Slack 인증에 실패했습니다. 다시 시도해주세요.",
    identity_failed: "사용자 정보를 가져오지 못했습니다.",
    forbidden_team: "이 워크스페이스는 접근이 제한되어 있습니다.",
  };

  return (
    <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
      {/* Top bar */}
      <div
        className="h-12 flex items-center gap-4 px-4 shrink-0"
        style={{
          background: "rgba(0, 0, 0, 0.8)",
          backdropFilter: "saturate(180%) blur(20px)",
          WebkitBackdropFilter: "saturate(180%) blur(20px)",
        }}
      >
        <span className="text-sm font-semibold text-white tracking-[-0.28px] font-sans shrink-0">
          remiel
        </span>
      </div>

      {/* Login card */}
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-6 p-8 rounded-xl border border-border bg-card shadow-lg w-80">
          <div className="flex flex-col items-center gap-2">
            <h1 className="text-lg font-semibold">로그인</h1>
            <p className="text-sm text-muted-foreground text-center">
              Slack 계정으로 로그인하여 remiel 대시보드에 접근합니다.
            </p>
          </div>

          {authError && (
            <div className="w-full rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2">
              <p className="text-sm text-destructive">
                {errorMessages[authError] ?? "로그인 중 오류가 발생했습니다."}
              </p>
            </div>
          )}

          <a
            href="/api/auth/slack"
            className="flex items-center justify-center gap-2 w-full rounded-md bg-[#4A154B] hover:bg-[#611f69] text-white text-sm font-medium px-4 py-2.5 transition-colors"
          >
            <svg width="20" height="20" viewBox="0 0 122.8 122.8" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z" fill="#E01E5A"/>
              <path d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" fill="#36C5F0"/>
              <path d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zm-6.5 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0S90.5 5.8 90.5 12.9v32.3z" fill="#2EB67D"/>
              <path d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9S117.2 90.5 109.9 90.5H77.6z" fill="#ECB22E"/>
            </svg>
            Slack으로 로그인
          </a>
        </div>
      </div>
    </div>
  );
}
