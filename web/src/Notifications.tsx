// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Asynchronous Ventures and contributors

import { Toast, type ToastManager } from '@base-ui/react/toast';
import { X } from 'lucide-react';
import './notifications.css';

export function Notifications({ manager }: { manager: ToastManager }) {
  return <Toast.Provider toastManager={manager} timeout={6000} limit={3}>
    <Toast.Portal>
      <Toast.Viewport className="notifications" aria-label="Notifications (F6)" aria-keyshortcuts="F6">
        <NotificationList />
      </Toast.Viewport>
    </Toast.Portal>
  </Toast.Provider>;
}

function NotificationList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map(toast => <Toast.Root key={toast.id} toast={toast} className="notification" aria-label="Notification" swipeDirection={[]}>
    <Toast.Content className="notification-content">
      <Toast.Description className="notification-message" />
      <Toast.Close className="notification-close" aria-label="Dismiss notification" aria-hidden={false}>
        <X size={16} aria-hidden="true" />
      </Toast.Close>
    </Toast.Content>
  </Toast.Root>);
}
