export interface SentOtp {
  email: string;
  code: string;
}

export interface SentInvitation {
  email: string;
  teamName: string;
  inviterName: string;
  token: string;
}
