import { noop } from 'lodash';

import {
    InvalidArgumentError,
    OrderFinalizationNotRequiredError,
    OrderRequestBody,
    PaymentArgumentInvalidError,
    PaymentInitializeOptions,
    PaymentIntegrationService,
    PaymentMethodClientUnavailableError,
    PaymentMethodInvalidError,
    PaymentRequestOptions,
    PaymentStrategy,
} from '@bigcommerce/checkout-sdk/payment-integration-api';
import { PayPalApmSdk, PayPalCommerceSdk } from '@bigcommerce/checkout-sdk/paypal-commerce-utils';
import { LoadingIndicator } from '@bigcommerce/checkout-sdk/ui';

import PayPalCommerceIntegrationService from '../paypal-commerce-integration-service';
import {
    ApproveCallbackPayload,
    NonInstantAlternativePaymentMethods,
    PayPalCommerceButtons,
    PayPalCommerceButtonsOptions,
    PayPalCommerceInitializationData,
} from '../paypal-commerce-types';

import PayPalCommerceAlternativeMethodsPaymentOptions, {
    WithPayPalCommerceAlternativeMethodsPaymentInitializeOptions,
} from './paypal-commerce-alternative-methods-payment-initialize-options';

export default class PayPalCommerceAlternativeMethodsPaymentStrategy implements PaymentStrategy {
    private loadingIndicatorContainer?: string;
    private orderId?: string;
    private paypalButton?: PayPalCommerceButtons;
    private paypalApms?: PayPalApmSdk;

    constructor(
        private paymentIntegrationService: PaymentIntegrationService,
        private paypalCommerceIntegrationService: PayPalCommerceIntegrationService,
        private paypalCommerceSdk: PayPalCommerceSdk,
        private loadingIndicator: LoadingIndicator,
    ) {}

    async initialize(
        options: PaymentInitializeOptions &
            WithPayPalCommerceAlternativeMethodsPaymentInitializeOptions,
    ): Promise<void> {
        const {
            gatewayId,
            methodId,
            paypalcommerce, // FIXME: this option is deprecated
            paypalcommercealternativemethods,
        } = options;
        const paypalOptions = paypalcommercealternativemethods || paypalcommerce;

        if (!methodId) {
            throw new InvalidArgumentError(
                'Unable to initialize payment because "options.methodId" argument is not provided.',
            );
        }

        if (!gatewayId) {
            throw new InvalidArgumentError(
                'Unable to initialize payment because "options.gatewayId" argument is not provided.',
            );
        }

        if (!paypalOptions) {
            throw new InvalidArgumentError(
                `Unable to initialize payment because "options.paypalcommercealternativemethods" argument is not provided.`,
            );
        }

        const state = this.paymentIntegrationService.getState();
        const paymentMethod = state.getPaymentMethodOrThrow<PayPalCommerceInitializationData>(
            methodId,
            gatewayId,
        );
        const { orderId, shouldRenderFields } = paymentMethod.initializationData || {};

        // Info:
        // The PayPal button and fields should not be rendered when shopper was redirected to Checkout page
        // after using smart payment button on PDP or Cart page. In this case backend returns order id if
        // it is available in checkout session. Therefore, it is not necessary to render PayPal button.
        if (orderId) {
            this.orderId = orderId;

            return;
        }

        this.paypalApms = await this.paypalCommerceSdk.getPayPalApmsSdk(
            paymentMethod,
            state.getCartOrThrow().currency.code,
        );

        this.loadingIndicatorContainer = paypalOptions.container.split('#')[1];

        this.renderButton(methodId, gatewayId, paypalOptions);

        if (shouldRenderFields) {
            this.renderFields(methodId, paypalOptions);
        }
    }

    async execute(payload: OrderRequestBody, options?: PaymentRequestOptions): Promise<void> {
        const { payment, ...order } = payload;

        if (!payment) {
            throw new PaymentArgumentInvalidError(['payment']);
        }

        const { methodId, gatewayId } = payment;

        if (!this.orderId) {
            throw new PaymentMethodInvalidError();
        }

        if (!this.isNonInstantPaymentMethod(methodId)) {
            await this.paymentIntegrationService.submitOrder(order, options);
        }

        await this.paypalCommerceIntegrationService.submitPayment(
            methodId,
            this.orderId,
            gatewayId,
        );
    }

    finalize(): Promise<void> {
        return Promise.reject(new OrderFinalizationNotRequiredError());
    }

    deinitialize(): Promise<void> {
        this.orderId = undefined;

        this.paypalButton?.close();

        return Promise.resolve();
    }

    /**
     *
     * Button methods/callbacks
     *
     * */
    private renderButton(
        methodId: string,
        gatewayId: string,
        paypalOptions: PayPalCommerceAlternativeMethodsPaymentOptions,
    ): void {
        const paypalAmpsSdk = this.getPaypalAmpsSdkOrThrow();

        const state = this.paymentIntegrationService.getState();
        const paymentMethod = state.getPaymentMethodOrThrow<PayPalCommerceInitializationData>(
            methodId,
            gatewayId,
        );
        const { buttonStyle } = paymentMethod.initializationData || {};

        const { container, onError, onRenderButton, submitForm } = paypalOptions;

        const buttonOptions: PayPalCommerceButtonsOptions = {
            fundingSource: methodId,
            style: this.paypalCommerceIntegrationService.getValidButtonStyle(buttonStyle),
            onInit: (_, actions) => paypalOptions.onInitButton(actions),
            createOrder: () => this.onCreateOrder(methodId, gatewayId, paypalOptions),
            onApprove: (data) => this.handleApprove(data, submitForm),
            onCancel: () => this.toggleLoadingIndicator(false),
            onError: (error) => this.handleFailure(error, onError),
            onClick: async (_, actions) =>
                paypalOptions.onValidate(actions.resolve, actions.reject),
        };

        this.paypalButton = paypalAmpsSdk.Buttons(buttonOptions);

        if (!this.paypalButton.isEligible()) {
            return;
        }

        if (onRenderButton && typeof onRenderButton === 'function') {
            onRenderButton();
        }

        this.paypalButton.render(container);
    }

    private async onCreateOrder(
        methodId: string,
        gatewayId: string,
        paypalOptions: PayPalCommerceAlternativeMethodsPaymentOptions,
    ): Promise<string> {
        const { onValidate } = paypalOptions;

        const onValidationPassed = () => {
            this.toggleLoadingIndicator(true);

            return () => Promise.resolve();
        };

        await onValidate(onValidationPassed, noop);

        const orderId = await this.paypalCommerceIntegrationService.createOrder(
            'paypalcommercealternativemethodscheckout',
        );

        if (this.isNonInstantPaymentMethod(methodId)) {
            const order = { useStoreCredit: false };
            const options = {
                params: {
                    methodId,
                    gatewayId,
                },
            };

            await this.paymentIntegrationService.submitOrder(order, options);
            await this.paypalCommerceIntegrationService.submitPayment(methodId, orderId, gatewayId);
        }

        return orderId;
    }

    private handleApprove(
        { orderID }: ApproveCallbackPayload,
        submitForm: PayPalCommerceAlternativeMethodsPaymentOptions['submitForm'],
    ): void {
        this.orderId = orderID;

        submitForm();
    }

    private handleFailure(
        error: Error,
        onError: PayPalCommerceAlternativeMethodsPaymentOptions['onError'],
    ): void {
        this.toggleLoadingIndicator(false);

        if (onError && typeof onError === 'function') {
            onError(error);
        }
    }

    /**
     *
     * Fields methods
     *
     * */
    private renderFields(
        methodId: string,
        paypalOptions: PayPalCommerceAlternativeMethodsPaymentOptions,
    ): void {
        const paypalAmpsSdk = this.getPaypalAmpsSdkOrThrow();
        const state = this.paymentIntegrationService.getState();
        const { firstName, lastName, email } = state.getBillingAddressOrThrow();

        const { apmFieldsContainer, apmFieldsStyles } = paypalOptions;

        if (!apmFieldsContainer) {
            throw new InvalidArgumentError(
                'Unable to initialize payment because "options.paypalcommercealternativemethods" argument should contain "apmFieldsContainer".',
            );
        }

        const fieldContainerElement = document.querySelector(apmFieldsContainer);

        if (fieldContainerElement) {
            fieldContainerElement.innerHTML = '';
        }

        const fieldsOptions = {
            fundingSource: methodId,
            style: apmFieldsStyles || {},
            fields: {
                name: {
                    value: `${firstName} ${lastName}`,
                },
                email: {
                    value: email,
                },
            },
        };

        const paypalPaymentFields = paypalAmpsSdk.PaymentFields(fieldsOptions);

        paypalPaymentFields.render(apmFieldsContainer);
    }

    /**
     *
     * Loading Indicator methods
     *
     * */
    private toggleLoadingIndicator(isLoading: boolean): void {
        if (isLoading && this.loadingIndicatorContainer) {
            this.loadingIndicator.show(this.loadingIndicatorContainer);
        } else {
            this.loadingIndicator.hide();
        }
    }

    /**
     *
     * Utils
     *
     * */
    private isNonInstantPaymentMethod(methodId: string): boolean {
        return methodId.toUpperCase() in NonInstantAlternativePaymentMethods;
    }

    private getPaypalAmpsSdkOrThrow() {
        if (!this.paypalApms) {
            throw new PaymentMethodClientUnavailableError();
        }

        return this.paypalApms;
    }
}
