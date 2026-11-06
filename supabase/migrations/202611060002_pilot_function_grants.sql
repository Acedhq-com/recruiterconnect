-- Remove Supabase's default authenticated-function grant. This public intake
-- intentionally runs only as anon; it is not a candidate-authorization endpoint.
revoke all on function public.register_pilot_interest(text, text, text, text, text, boolean)
from authenticated;
